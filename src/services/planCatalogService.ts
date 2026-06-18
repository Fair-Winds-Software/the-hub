// Authorized by HUB-1466 — createPlan(): Stripe Product/Price creation with billing type mapping
// Authorized by HUB-1467 — archivePlan(): soft-archive + immutable ledger entry
// Authorized by HUB-1468 — getPlans(), getPlanById(): plan list and BILL-004 planId resolution
// Authorized by HUB-1489 — archivePlan() enqueues grandfather-subscribers BullMQ job
import type Stripe from 'stripe';
import { getPool } from '../db/pool.js';
import { getStripe, stripeIdempotencyKey, mapStripeError } from '../stripe/client.js';
import { AppError } from '../errors/AppError.js';

export type BillingType = 'flat_rate' | 'per_seat' | 'metered' | 'tiered' | 'one_time';
export type BillingInterval = 'month' | 'quarter' | 'year' | 'one_time';

export interface PlanDef {
  key: string;
  name: string;
  description?: string;
  billingType: BillingType;
  billingInterval?: BillingInterval;
  unitAmountCents?: number;
  tiers?: Array<{ upTo: number | null; unitAmount: number }>;
  entitlements?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PlanRow {
  id: string;
  product_id: string;
  key: string;
  name: string;
  description: string | null;
  billing_type: BillingType;
  billing_interval: BillingInterval | null;
  unit_amount_cents: number | null;
  tiers: unknown | null;
  stripe_product_id: string;
  stripe_price_id: string;
  entitlements: Record<string, unknown>;
  active: boolean;
  metadata: unknown | null;
  delta_data: unknown | null;
  created_at: Date;
  updated_at: Date;
}

const INTERVAL_MAP: Record<string, { interval: 'month' | 'year'; interval_count: number }> = {
  month:   { interval: 'month', interval_count: 1 },
  quarter: { interval: 'month', interval_count: 3 },
  year:    { interval: 'year',  interval_count: 1 },
};

// Pure mapper — translates HUB billing type/interval to Stripe PriceCreateParams.
// Exported for isolated unit testing (HUB-1466 AC-8).
export function buildStripePriceParams(
  billingType: BillingType,
  billingInterval: BillingInterval | undefined,
  planDef: PlanDef,
  stripeProductId: string,
): Stripe.PriceCreateParams {
  if (billingType === 'one_time') {
    return {
      product: stripeProductId,
      currency: 'usd',
      unit_amount: planDef.unitAmountCents ?? 0,
    };
  }

  const intervalKey = billingInterval && billingInterval !== 'one_time' ? billingInterval : 'month';
  const intervalParams = INTERVAL_MAP[intervalKey] ?? { interval: 'month' as const, interval_count: 1 };

  if (billingType === 'metered') {
    return {
      product: stripeProductId,
      currency: 'usd',
      billing_scheme: 'per_unit',
      recurring: { ...intervalParams, usage_type: 'metered' },
    };
  }

  if (billingType === 'tiered') {
    return {
      product: stripeProductId,
      currency: 'usd',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      recurring: { ...intervalParams, usage_type: 'licensed' },
      tiers: (planDef.tiers ?? []).map((t) => ({
        up_to: t.upTo === null ? 'inf' : t.upTo,
        unit_amount: t.unitAmount,
      })),
    };
  }

  // flat_rate and per_seat
  return {
    product: stripeProductId,
    currency: 'usd',
    billing_scheme: 'per_unit',
    unit_amount: planDef.unitAmountCents,
    recurring: { ...intervalParams, usage_type: 'licensed' },
  };
}

async function withStripeTimeout<T>(fn: () => Promise<T>, ms = 5000): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Stripe API call timed out after 5s')), ms),
  );
  return Promise.race([fn(), timeout]);
}

// Resolves or creates the Stripe Product for a HUB product.
// Caches stripe_product_id on the products row to avoid duplicate Stripe Products.
async function resolveOrCreateStripeProduct(productId: string): Promise<string> {
  const pool = getPool();

  const { rows } = await pool.query<{ stripe_product_id: string | null; name: string }>(
    'SELECT stripe_product_id, name FROM products WHERE id = $1',
    [productId],
  );
  if (!rows[0]) throw new AppError(404, 'Product not found');
  if (rows[0].stripe_product_id) return rows[0].stripe_product_id;

  const stripe = getStripe();
  let stripeProduct: Stripe.Product;
  try {
    stripeProduct = await withStripeTimeout(() =>
      stripe.products.create(
        { name: rows[0]!.name, metadata: { hub_product_id: productId } },
        { idempotencyKey: stripeIdempotencyKey('create-product', productId) },
      ),
    );
  } catch (err) {
    mapStripeError(err);
  }

  await pool.query(
    'UPDATE products SET stripe_product_id = $1 WHERE id = $2',
    [stripeProduct!.id, productId],
  );

  return stripeProduct!.id;
}

// Creates a HUB billing plan: resolves/creates Stripe Product and Price, inserts plans row.
// Idempotent by (product_id, key): returns existing plan if found.
export async function createPlan(productId: string, planDef: PlanDef): Promise<PlanRow> {
  const pool = getPool();

  // Idempotency check
  const { rows: existing } = await pool.query<PlanRow>(
    'SELECT * FROM plans WHERE product_id = $1 AND key = $2',
    [productId, planDef.key],
  );
  if (existing[0]) return existing[0];

  const stripeProductId = await resolveOrCreateStripeProduct(productId);
  const priceParams = buildStripePriceParams(
    planDef.billingType,
    planDef.billingInterval,
    planDef,
    stripeProductId,
  );

  const stripe = getStripe();
  let stripePrice: Stripe.Price;
  try {
    stripePrice = await withStripeTimeout(() =>
      stripe.prices.create(priceParams, {
        idempotencyKey: stripeIdempotencyKey('create-price', productId, planDef.key),
      }),
    );
  } catch (err) {
    mapStripeError(err);
  }

  const { rows } = await pool.query<PlanRow>(
    `INSERT INTO plans
       (product_id, key, name, description, billing_type, billing_interval,
        unit_amount_cents, tiers, stripe_product_id, stripe_price_id,
        entitlements, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      productId,
      planDef.key,
      planDef.name,
      planDef.description ?? null,
      planDef.billingType,
      planDef.billingInterval ?? null,
      planDef.unitAmountCents ?? null,
      planDef.tiers ? JSON.stringify(planDef.tiers) : null,
      stripeProductId,
      stripePrice!.id,
      JSON.stringify(planDef.entitlements ?? {}),
      planDef.metadata ? JSON.stringify(planDef.metadata) : null,
    ],
  );

  return rows[0]!;
}

// Soft-archives a plan: sets active=false and inserts an immutable plan_archive_ledger row.
// Does NOT call Stripe — existing subscriptions on the archived Stripe Price remain valid.
export async function archivePlan(
  planId: string,
  reason?: string,
  archivedBy?: string,
): Promise<PlanRow> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<PlanRow>(
      'SELECT * FROM plans WHERE id = $1 FOR UPDATE',
      [planId],
    );
    if (!rows[0]) throw new AppError(404, 'Plan not found');
    if (!rows[0].active) throw new AppError(409, 'Plan is already archived');

    await client.query('UPDATE plans SET active = false WHERE id = $1', [planId]);

    await client.query(
      `INSERT INTO plan_archive_ledger
         (plan_id, archived_at, reason, archived_by, previous_stripe_price_id)
       VALUES ($1, NOW(), $2, $3, $4)`,
      [planId, reason ?? null, archivedBy ?? null, rows[0].stripe_price_id],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows: updated } = await pool.query<PlanRow>(
    'SELECT * FROM plans WHERE id = $1',
    [planId],
  );

  // Enqueue grandfathering job asynchronously — does not block the archive response
  const { getBillingJobsQueue } = await import('../queues/index.js');
  await getBillingJobsQueue().add('grandfather-subscribers', { planId });

  return updated[0]!;
}

// Lists plans for a product. Excludes archived plans by default.
export async function getPlans(
  productId: string,
  options: { includeArchived?: boolean } = {},
): Promise<PlanRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<PlanRow>(
    `SELECT * FROM plans
     WHERE product_id = $1
     ${options.includeArchived ? '' : 'AND active = true'}
     ORDER BY created_at ASC`,
    [productId],
  );
  return rows;
}

// Resolves a planId to its full PlanRow, including stripe_price_id (BILL-004 resolver).
export async function getPlanById(planId: string): Promise<PlanRow> {
  const pool = getPool();
  const { rows } = await pool.query<PlanRow>(
    'SELECT * FROM plans WHERE id = $1',
    [planId],
  );
  if (!rows[0]) throw new AppError(404, 'Plan not found');
  return rows[0];
}
