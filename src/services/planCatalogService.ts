// Authorized by HUB-1466 — createPlan(): Stripe Product/Price creation with billing type mapping
// Authorized by HUB-1467 — archivePlan(): soft-archive + immutable ledger entry
// Authorized by HUB-1468 — getPlans(), getPlanById(): plan list and BILL-004 planId resolution
// Authorized by HUB-1489 — archivePlan() enqueues grandfather-subscribers BullMQ job
// Authorized by HUB-1591 (E-BE-1 S8, CR-2) — updatePlanBillingMode(): operator-driven flip of
//   plans.billing_mode between 'standard' and 'credit'. Per R1: no compensating transactions
//   in v0.1 (existing Stripe subscriptions on flipped plans stay until renewal; new invoices
//   match the post-flip mode). Audit row written; isCreditMode cache invalidated.
import type Stripe from 'stripe';
import { getPool } from '../db/pool.js';
import { getStripe, stripeIdempotencyKey, mapStripeError } from '../stripe/client.js';
import { AppError } from '../errors/AppError.js';
import { clearCreditModeCacheEntry } from './stripeService.js';
import { writeAuditEntry } from './auditLogService.js';

export type BillingMode = 'standard' | 'credit';

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
/**
 * HUB-1591 (CR-2): operator-driven flip of a plan's billing_mode. The 4 sub-cases form the
 * R1-locked transition matrix:
 *
 *   S → S  : no-op (returns the existing row; no UPDATE, no audit, no cache evict)
 *   C → C  : no-op (same)
 *   S → C  : UPDATE plans.billing_mode = 'credit'; audit row; cache evict for planId
 *   C → S  : UPDATE plans.billing_mode = 'standard'; audit row; cache evict for planId
 *
 * Per R1: no compensating transactions in v0.1. Existing Stripe subscriptions on plans
 * flipped S→C stay in Stripe until their natural renewal; new invoices on this plan after
 * the flip take the HUB-internal path (per HUB-1590 createInternalInvoice). Operator-facing
 * confirmation modal copy lives in the FE (HUB-1563).
 *
 * Throws 404 if the plan does not exist. Throws 400 if newMode is not 'standard' | 'credit'
 * (defensive against caller misuse; the route layer also validates the body).
 */
export async function updatePlanBillingMode(
  planId: string,
  newMode: BillingMode,
  actorId: string,
): Promise<PlanRow> {
  if (newMode !== 'standard' && newMode !== 'credit') {
    throw new AppError(400, 'billing_mode must be one of standard | credit');
  }

  const pool = getPool();
  const { rows: existing } = await pool.query<PlanRow & { billing_mode: BillingMode }>(
    `SELECT id, product_id, key, name, description, billing_type, billing_interval,
            unit_amount_cents, tiers, stripe_product_id, stripe_price_id, entitlements,
            active, metadata, delta_data, created_at, updated_at, billing_mode
       FROM plans
      WHERE id = $1`,
    [planId],
  );
  if (!existing[0]) {
    throw new AppError(404, 'Plan not found');
  }

  const oldMode: BillingMode = existing[0].billing_mode;

  // S→S and C→C: no-op early return. Returning the existing row (minus the billing_mode
  // discriminator field that PlanRow doesn't expose) keeps the call idempotent for the
  // operator UI (PUT can be safely retried).
  if (oldMode === newMode) {
    const { billing_mode: _bm, ...rest } = existing[0];
    return rest;
  }

  const { rows: updated } = await pool.query<PlanRow>(
    `UPDATE plans SET billing_mode = $2, updated_at = NOW() WHERE id = $1
     RETURNING id, product_id, key, name, description, billing_type, billing_interval,
       unit_amount_cents, tiers, stripe_product_id, stripe_price_id, entitlements,
       active, metadata, delta_data, created_at, updated_at`,
    [planId, newMode],
  );

  await writeAuditEntry({
    tenant_id: '00000000-0000-0000-0000-0000000000a1',
    product_id: existing[0].product_id,
    actor_id: actorId,
    actor_type: 'operator',
    operation: 'UPDATE',
    table_name: 'plans',
    record_id: planId,
    old_values: { billing_mode: oldMode },
    new_values: {
      billing_mode: newMode,
      event: 'plan.billing_mode.changed',
      from: oldMode,
      to: newMode,
    },
  });

  // Targeted cache invalidation — next isCreditMode(planId) re-reads from DB.
  clearCreditModeCacheEntry(planId);

  return updated[0]!;
}

export async function getPlanById(planId: string): Promise<PlanRow> {
  const pool = getPool();
  const { rows } = await pool.query<PlanRow>(
    'SELECT * FROM plans WHERE id = $1',
    [planId],
  );
  if (!rows[0]) throw new AppError(404, 'Plan not found');
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// HUB-1651 (E-FE-5 S1) — admin CRUD extensions
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdatePlanPatch {
  name?: string;
  description?: string | null;
  unit_amount_cents?: number | null;
  // HUB-1718/1715/1716 (E-V2-PP-1) LaunchKit pricing primitives fields.
  // volume_ladder is a JSONB shape [{min_quantity, max_quantity, unit_amount_cents, sort_order}].
  volume_ladder?: unknown;
  first_n_free_quantity?: number;
  quantity_metered_dimension?: string | null;
  // HUB-1745 (E-V2-PP-3 S5) — Synapz multi-dimension tier shape.
  // tiers = [{upTo, unitAmount, overage_rates?: [{dimension_key, included_quantity, rate_per_unit_cents}]}].
  tiers?: unknown;
  // dimensions[] persists to plan_metered_dimensions (delete-not-in-payload + upsert).
  dimensions?: Array<{ dimension_key: string; dimension_label: string; sort_order: number }>;
}

/**
 * HUB-1651 (E-FE-5 S1): partial update of a plan's mutable fields (name,
 * description, unit_amount_cents). Emits an audit_log entry via
 * writeAuditEntry. Throws 404 if the plan does not exist. Fields not
 * present on the patch object are left untouched. billing_mode changes
 * flow through {@link updatePlanBillingMode} — this function refuses
 * `billing_mode` in the patch to prevent bypassing the two-step confirm
 * contract established by HUB-1591.
 */
export async function updatePlan(
  planId: string,
  patch: UpdatePlanPatch,
  actorId: string | null,
): Promise<PlanRow> {
  const pool = getPool();

  const setFragments: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (patch.name !== undefined) {
    setFragments.push(`name = $${idx++}`);
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    setFragments.push(`description = $${idx++}`);
    params.push(patch.description);
  }
  if (patch.unit_amount_cents !== undefined) {
    setFragments.push(`unit_amount_cents = $${idx++}`);
    params.push(patch.unit_amount_cents);
  }
  // HUB-1718 (E-V2-PP-1 S5 supplement) — accept LaunchKit pricing primitives on PUT.
  if (patch.volume_ladder !== undefined) {
    setFragments.push(`volume_ladder = $${idx++}::jsonb`);
    params.push(JSON.stringify(patch.volume_ladder));
  }
  if (patch.first_n_free_quantity !== undefined) {
    setFragments.push(`first_n_free_quantity = $${idx++}`);
    params.push(patch.first_n_free_quantity);
  }
  if (patch.quantity_metered_dimension !== undefined) {
    setFragments.push(`quantity_metered_dimension = $${idx++}`);
    params.push(patch.quantity_metered_dimension);
  }
  // HUB-1745 (E-V2-PP-3 S5) — extended tiers JSONB with nested overage_rates.
  if (patch.tiers !== undefined) {
    setFragments.push(`tiers = $${idx++}::jsonb`);
    params.push(JSON.stringify(patch.tiers));
  }

  const { rows: before } = await pool.query<PlanRow>(
    'SELECT * FROM plans WHERE id = $1',
    [planId],
  );
  if (!before[0]) throw new AppError(404, 'Plan not found');

  // HUB-1745 (E-V2-PP-3 S5) — sync plan_metered_dimensions if the payload sets it.
  // Delete-not-in-payload + insert-if-new pattern; all inside the same client so
  // it's atomic with the plans UPDATE below.
  const shouldSyncDimensions = patch.dimensions !== undefined;

  if (setFragments.length === 0 && !shouldSyncDimensions) return before[0];

  // If only dimensions changed, still touch updated_at.
  if (setFragments.length === 0) {
    setFragments.push('updated_at = NOW()');
  } else {
    setFragments.push('updated_at = NOW()');
  }
  params.push(planId);

  const client = await pool.connect();
  let updated: PlanRow[];
  try {
    await client.query('BEGIN');
    const { rows: updRows } = await client.query<PlanRow>(
      `UPDATE plans SET ${setFragments.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    updated = updRows;

    if (shouldSyncDimensions) {
      const declared = patch.dimensions ?? [];
      // Delete any existing dimension rows for this plan that aren't in the new payload.
      const declaredKeys = declared.map((d) => d.dimension_key);
      if (declaredKeys.length === 0) {
        await client.query(
          `DELETE FROM plan_metered_dimensions WHERE plan_id = $1`, [planId],
        );
      } else {
        await client.query(
          `DELETE FROM plan_metered_dimensions
            WHERE plan_id = $1 AND dimension_key <> ALL($2::text[])`,
          [planId, declaredKeys],
        );
      }
      // Upsert each declared row.
      for (const d of declared) {
        await client.query(
          `INSERT INTO plan_metered_dimensions
              (plan_id, dimension_key, dimension_label, sort_order)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (plan_id, dimension_key)
           DO UPDATE SET dimension_label = EXCLUDED.dimension_label,
                         sort_order = EXCLUDED.sort_order`,
          [planId, d.dimension_key, d.dimension_label, d.sort_order],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  await writeAuditEntry({
    tenant_id: '00000000-0000-0000-0000-0000000000a1',
    product_id: before[0].product_id,
    actor_id: actorId,
    actor_type: 'operator',
    operation: 'UPDATE',
    table_name: 'plans',
    record_id: planId,
    old_values: {
      name: before[0].name,
      description: before[0].description,
      unit_amount_cents: before[0].unit_amount_cents,
    },
    new_values: {
      name: updated[0]!.name,
      description: updated[0]!.description,
      unit_amount_cents: updated[0]!.unit_amount_cents,
    },
  });

  return updated[0]!;
}

/**
 * HUB-1651 (E-FE-5 S1): soft-archive a plan with an active-subscribers
 * guard. Checks {@link stripe_subscriptions} for rows referencing this
 * planId with status IN ('active','trialing','past_due'); if any exist,
 * throws AppError(422) whose message contains the current active count so
 * the route can echo it back to the operator UI. Otherwise sets
 * `active=false` AND `archived_at=NOW()` atomically, writes an audit_log
 * entry, and returns the updated row. Idempotent: re-archiving an
 * already-archived plan returns the existing row without a second audit
 * write.
 */
export interface SoftArchivePlanError422 extends AppError {
  activeSubscribers: number;
}

export async function softArchivePlan(
  planId: string,
  actorId: string | null,
): Promise<PlanRow> {
  const pool = getPool();
  const { rows: before } = await pool.query<PlanRow & { archived_at: Date | null }>(
    'SELECT * FROM plans WHERE id = $1',
    [planId],
  );
  if (!before[0]) throw new AppError(404, 'Plan not found');
  if (before[0].archived_at !== null) return before[0];

  const { rows: subs } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
       FROM stripe_subscriptions
      WHERE plan_id = $1
        AND status IN ('active','trialing','past_due')`,
    [planId],
  );
  const activeSubscribers = parseInt(subs[0]!.count, 10);
  if (activeSubscribers > 0) {
    const err = new AppError(
      422,
      `Plan has ${activeSubscribers} active subscriber(s); archive blocked`,
    ) as SoftArchivePlanError422;
    err.activeSubscribers = activeSubscribers;
    throw err;
  }

  const { rows: updated } = await pool.query<PlanRow>(
    `UPDATE plans
        SET active = false,
            archived_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
   RETURNING *`,
    [planId],
  );

  await writeAuditEntry({
    tenant_id: '00000000-0000-0000-0000-0000000000a1',
    product_id: before[0].product_id,
    actor_id: actorId,
    actor_type: 'operator',
    operation: 'DELETE',
    table_name: 'plans',
    record_id: planId,
    old_values: { active: true, archived_at: null },
    new_values: {
      active: false,
      archived_at: updated[0]!.updated_at,
      event: 'plan.soft_archived',
    },
  });

  return updated[0]!;
}
