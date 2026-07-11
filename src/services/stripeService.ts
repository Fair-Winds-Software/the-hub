// Authorized by HUB-426 — ensureStripeCustomer: get-or-create Stripe customer, upsert stripe_customers
// Authorized by HUB-427 — createSubscription, cancelSubscription, getSubscription
// Authorized by HUB-428 — handleSubscriptionUpdated, handleSubscriptionDeleted webhook processors
// Authorized by HUB-1491 — handleSubscriptionUpdated enqueues confirm-plan-change BullMQ job
// Authorized by HUB-1470 — BILL-004 wire-up: createSubscription accepts planId; resolves stripe_price_id internally
// Authorized by HUB-1589 (E-BE-1 S6, CR-2) — isCreditMode(planId) guard + credit-mode bypass branches
//   in createSubscription/cancelSubscription. Runtime Stripe SDK calls in HUB land via getStripe()
//   from src/stripe/client.ts (the single boundary file); the ESLint rule + scripts/lint-stripe-boundary.ts
//   gate enforce that no other module imports the runtime SDK. Type-only `import type Stripe from 'stripe'`
//   is permitted everywhere — type imports erase at runtime and cannot make Stripe calls.
//
// INVARIANT: Plans with billing_mode='credit' MUST NOT produce any Stripe SDK calls. Verified by
// __tests__/billingMode.guard.integration.test.ts asserting zero mock invocations on the Stripe SDK
// for credit-mode createSubscription/cancelSubscription.
// HUB-1781 (S8 of HUB-1773): SDK access routed through StripeConnection registry —
// getStripeConnection() returns Live or Mock adapter based on operator-set mode. The
// adapter internally applies withStripeTimeout + mapStripeError + Zod validation, so
// the try/catch blocks below wrapping mapStripeError are now no-ops in success paths
// (adapter throws AppError directly); they remain for narrower diff / defensive parity
// with pre-migration behavior.
// HUB-1781 (S8): retained `import type Stripe from 'stripe'` for the webhook handler
// paths below that parse stored raw_event JSON — those payloads have Stripe SDK shape
// by construction (captured verbatim at receive time). Type-only imports are permitted
// everywhere per scripts/lint-stripe-boundary.mjs; they erase at runtime.
import type Stripe from 'stripe';
import crypto from 'crypto';
import { getPool } from '../db/pool.js';
import { stripeIdempotencyKey, mapStripeError } from '../stripe/client.js';
import { getStripeConnection } from '../stripe/registry.js';
import type { Customer, Subscription } from '../stripe/schemas.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getPlanById } from './planCatalogService.js';

// HUB-1589: synthetic stripe_subscription_id + stripe_price_id markers used for credit-mode
// subscriptions. Downstream consumers (HUB-1590 invoiceService, HUB-1591 planChangeService)
// branch on this prefix to skip Stripe-coupled paths.
const CREDIT_SUB_ID_PREFIX = 'internal:credit:';
const CREDIT_PRICE_ID_PREFIX = 'internal:credit-price:';

// HUB-1589 R1 FIX#1: in-process memo for plans.billing_mode lookups. A plan's billing_mode
// can be re-configured by an operator while the process is up; the cache is intentionally
// process-lifetime (no TTL) at v0.1 single-tenant scale. Tests call clearCreditModeCache()
// to reset between scenarios. v0.2 with multi-tenant scale: switch to per-request memo
// (Fastify request-decorator or a small TTL of ≤60s).
const creditModeCache = new Map<string, boolean>();

export function clearCreditModeCache(): void {
  creditModeCache.clear();
}

/**
 * HUB-1591: targeted invalidation of a single planId's cached billing_mode. Called by
 * `planCatalogService.updatePlanBillingMode` after the column UPDATE commits so the next
 * `isCreditMode(planId)` call re-reads from the DB.
 */
export function clearCreditModeCacheEntry(planId: string): void {
  creditModeCache.delete(planId);
}

/**
 * HUB-1589 (CR-2): returns true if the given plan is credit-mode (no Stripe SDK writes).
 * Reads `plans.billing_mode` with in-process memoization (see cache comment above).
 *
 * Throws AppError(404) if the plan does not exist — propagating to the caller so credit-mode
 * checks fail closed rather than defaulting to standard (which would risk a Stripe call against
 * an unknown plan).
 */
export async function isCreditMode(planId: string): Promise<boolean> {
  const cached = creditModeCache.get(planId);
  if (cached !== undefined) return cached;

  const { rows } = await getPool().query<{ billing_mode: string }>(
    `SELECT billing_mode FROM plans WHERE id = $1`,
    [planId],
  );
  if (!rows[0]) throw new AppError(404, 'Plan not found');

  const isCredit = rows[0].billing_mode === 'credit';
  creditModeCache.set(planId, isCredit);
  return isCredit;
}

/**
 * Helper used by cancelSubscription + downstream readers to short-circuit any Stripe SDK
 * call when the subscription row already carries an internal-credit synthetic ID.
 */
function isCreditSubscriptionId(stripeSubscriptionId: string): boolean {
  return stripeSubscriptionId.startsWith(CREDIT_SUB_ID_PREFIX);
}

export interface StripeSubscriptionRow {
  id: string;
  tenant_id: string;
  product_id: string;
  plan_id: string | null;
  stripe_subscription_id: string;
  stripe_price_id: string;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// Gets or creates a Stripe customer for the tenant. Returns the stripe_customer_id.
// Idempotent: if stripe_customers row already exists, returns without calling Stripe.
export async function ensureStripeCustomer(tenantId: string, email: string): Promise<string> {
  const pool = getPool();

  const { rows } = await pool.query<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM stripe_customers WHERE tenant_id = $1',
    [tenantId],
  );

  if (rows[0]) return rows[0].stripe_customer_id;

  const stripe = getStripeConnection();
  let customer: Customer;
  try {
    customer = await stripe.customers.create(
      { email, metadata: { tenant_id: tenantId } },
      { idempotencyKey: stripeIdempotencyKey('create-customer', tenantId) },
    );
  } catch (err) {
    mapStripeError(err);
  }

  const { rows: upserted } = await pool.query<{ stripe_customer_id: string }>(
    `INSERT INTO stripe_customers (tenant_id, stripe_customer_id)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id
     RETURNING stripe_customer_id`,
    [tenantId, customer!.id],
  );

  return upserted[0].stripe_customer_id;
}

// Creates a Stripe subscription for the given tenant + product, persists to stripe_subscriptions.
// Accepts planId (BILL-004): resolves stripe_price_id internally via plans table.
// Idempotent via Stripe idempotency key derived from tenantId + productId + planId.
export async function createSubscription(
  tenantId: string,
  productId: string,
  planId: string,
  email: string,
): Promise<StripeSubscriptionRow> {
  const plan = await getPlanById(planId);
  if (!plan.active) throw new AppError(400, 'Plan is archived');

  // HUB-1589 (CR-2): credit-mode bypass. Skip ensureStripeCustomer + stripe.subscriptions.create
  // entirely; insert a stripe_subscriptions row with synthetic internal IDs so HUB-1590
  // invoiceService et al see a consistent row shape. The boundary CI script
  // (scripts/lint-stripe-boundary.ts) verifies no module outside src/stripe/client.ts
  // imports the runtime SDK, so this bypass is structurally enforced.
  if (await isCreditMode(planId)) {
    const pool = getPool();
    const synthSubId = `${CREDIT_SUB_ID_PREFIX}${crypto.randomUUID()}`;
    const synthPriceId = `${CREDIT_PRICE_ID_PREFIX}${planId}`;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query<StripeSubscriptionRow>(
      `INSERT INTO stripe_subscriptions
         (tenant_id, product_id, plan_id, stripe_subscription_id, stripe_price_id, status,
          current_period_start, current_period_end, cancel_at_period_end)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, false)
       ON CONFLICT (tenant_id, product_id) DO UPDATE
         SET plan_id                = EXCLUDED.plan_id,
             stripe_subscription_id = EXCLUDED.stripe_subscription_id,
             stripe_price_id        = EXCLUDED.stripe_price_id,
             status                 = EXCLUDED.status,
             current_period_start   = EXCLUDED.current_period_start,
             current_period_end     = EXCLUDED.current_period_end,
             cancel_at_period_end   = EXCLUDED.cancel_at_period_end
       RETURNING *`,
      [tenantId, productId, planId, synthSubId, synthPriceId, now, periodEnd],
    );
    logger.info(
      { tenantId, productId, planId, event: 'subscription.credit_mode.created' },
      'CR-2 credit-mode subscription — Stripe SDK bypassed',
    );
    return rows[0]!;
  }

  const priceId = plan.stripe_price_id;
  const customerId = await ensureStripeCustomer(tenantId, email);
  const stripe = getStripeConnection();

  let sub: Subscription;
  try {
    sub = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: priceId }],
        metadata: { tenant_id: tenantId, product_id: productId },
      },
      { idempotencyKey: stripeIdempotencyKey('create-sub', tenantId, productId, planId) },
    );
  } catch (err) {
    mapStripeError(err);
  }

  const item = sub!.items.data[0];
  const pool = getPool();
  const { rows } = await pool.query<StripeSubscriptionRow>(
    `INSERT INTO stripe_subscriptions
       (tenant_id, product_id, plan_id, stripe_subscription_id, stripe_price_id, status,
        current_period_start, current_period_end, cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8), $9)
     ON CONFLICT (tenant_id, product_id) DO UPDATE
       SET plan_id                = EXCLUDED.plan_id,
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           stripe_price_id        = EXCLUDED.stripe_price_id,
           status                 = EXCLUDED.status,
           current_period_start   = EXCLUDED.current_period_start,
           current_period_end     = EXCLUDED.current_period_end,
           cancel_at_period_end   = EXCLUDED.cancel_at_period_end
     RETURNING *`,
    [
      tenantId,
      productId,
      planId,
      sub!.id,
      item?.price.id ?? priceId,
      sub!.status,
      item?.current_period_start ?? 0,
      item?.current_period_end ?? 0,
      sub!.cancel_at_period_end,
    ],
  );

  return rows[0];
}

// Cancels a subscription. immediate=false (default) schedules at period end;
// immediate=true cancels now. Throws AppError(404) if no subscription found.
export async function cancelSubscription(
  tenantId: string,
  productId: string,
  immediate: boolean = false,
): Promise<StripeSubscriptionRow> {
  const pool = getPool();
  const { rows } = await pool.query<{ stripe_subscription_id: string }>(
    'SELECT stripe_subscription_id FROM stripe_subscriptions WHERE tenant_id = $1 AND product_id = $2',
    [tenantId, productId],
  );

  if (!rows[0]) {
    throw new AppError(404, 'Subscription not found');
  }

  // HUB-1589 (CR-2): credit-mode subscriptions carry an internal synthetic stripe_subscription_id;
  // detect via the prefix and skip the Stripe SDK call entirely. Local DB state is still updated
  // so the operator-facing subscription status reflects the cancellation.
  if (isCreditSubscriptionId(rows[0].stripe_subscription_id)) {
    if (immediate) {
      const { rows: updated } = await pool.query<StripeSubscriptionRow>(
        `UPDATE stripe_subscriptions
         SET status = 'canceled', cancelled_at = NOW()
         WHERE tenant_id = $1 AND product_id = $2
         RETURNING *`,
        [tenantId, productId],
      );
      return updated[0]!;
    }
    const { rows: updated } = await pool.query<StripeSubscriptionRow>(
      `UPDATE stripe_subscriptions
       SET cancel_at_period_end = true
       WHERE tenant_id = $1 AND product_id = $2
       RETURNING *`,
      [tenantId, productId],
    );
    return updated[0]!;
  }

  const stripe = getStripeConnection();
  if (immediate) {
    try {
      await stripe.subscriptions.cancel(rows[0].stripe_subscription_id);
    } catch (err) {
      mapStripeError(err);
    }

    const { rows: updated } = await pool.query<StripeSubscriptionRow>(
      `UPDATE stripe_subscriptions
       SET status = 'canceled', cancelled_at = NOW()
       WHERE tenant_id = $1 AND product_id = $2
       RETURNING *`,
      [tenantId, productId],
    );

    return updated[0];
  }

  try {
    await stripe.subscriptions.update(rows[0].stripe_subscription_id, {
      cancel_at_period_end: true,
    });
  } catch (err) {
    mapStripeError(err);
  }

  const { rows: updated } = await pool.query<StripeSubscriptionRow>(
    `UPDATE stripe_subscriptions
     SET cancel_at_period_end = true
     WHERE tenant_id = $1 AND product_id = $2
     RETURNING *`,
    [tenantId, productId],
  );

  return updated[0];
}

// Returns all subscriptions for a tenant, ordered newest first.
export async function getSubscriptions(tenantId: string): Promise<StripeSubscriptionRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<StripeSubscriptionRow>(
    'SELECT * FROM stripe_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId],
  );
  return rows;
}

// Webhook processor for customer.subscription.updated events.
// Fetches the raw Stripe event from the DB, then upserts stripe_subscriptions.
export async function handleSubscriptionUpdated(eventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ raw_event: string }>(
    'SELECT raw_event FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );

  if (!rows[0]) {
    logger.warn({ eventId }, 'handleSubscriptionUpdated: event not found in DB');
    return;
  }

  const event = JSON.parse(rows[0].raw_event) as Stripe.Event;
  const sub = event.data.object as Stripe.Subscription;
  const productId = sub.metadata?.product_id;
  const tenantId = sub.metadata?.tenant_id;

  if (!productId || !tenantId) {
    logger.warn({ eventId, subId: sub.id }, 'handleSubscriptionUpdated: missing metadata — skipping upsert');
    return;
  }

  const item = sub.items.data[0];
  await pool.query(
    `INSERT INTO stripe_subscriptions
       (tenant_id, product_id, stripe_subscription_id, stripe_price_id, status,
        current_period_start, current_period_end, cancel_at_period_end, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8, $9)
     ON CONFLICT (tenant_id, product_id) DO UPDATE
       SET stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           stripe_price_id        = EXCLUDED.stripe_price_id,
           status                 = EXCLUDED.status,
           current_period_start   = EXCLUDED.current_period_start,
           current_period_end     = EXCLUDED.current_period_end,
           cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
           cancelled_at           = EXCLUDED.cancelled_at`,
    [
      tenantId,
      productId,
      sub.id,
      item?.price.id ?? '',
      sub.status,
      item?.current_period_start ?? 0,
      item?.current_period_end ?? 0,
      sub.cancel_at_period_end,
      sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    ],
  );

  logger.info({ eventId, subId: sub.id, tenantId, productId }, 'subscription updated');

  // Enqueue plan-change confirmation (no-op if no pending ledger entry)
  if (tenantId && productId) {
    const { getBillingJobsQueue } = await import('../queues/index.js');
    await getBillingJobsQueue().add('confirm-plan-change', {
      tenantId,
      productId,
      newStripePriceId: item?.price.id ?? '',
    });
  }
}

// Webhook processor for customer.subscription.deleted events.
// Marks the subscription as canceled in stripe_subscriptions.
export async function handleSubscriptionDeleted(eventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ raw_event: string }>(
    'SELECT raw_event FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );

  if (!rows[0]) {
    logger.warn({ eventId }, 'handleSubscriptionDeleted: event not found in DB');
    return;
  }

  const event = JSON.parse(rows[0].raw_event) as Stripe.Event;
  const sub = event.data.object as Stripe.Subscription;

  await pool.query(
    `UPDATE stripe_subscriptions
     SET status = 'canceled', cancelled_at = NOW()
     WHERE stripe_subscription_id = $1`,
    [sub.id],
  );

  logger.info({ eventId, subId: sub.id }, 'subscription deleted');
}

// Authorized by HUB-1686 (E-FE-13 S1) — triggers a payment retry on a
// stripe invoice. Wraps Stripe SDK's invoices.pay(invoiceId). Idempotent
// against Stripe's own retry semantics (Stripe returns the invoice's
// current state if already paid), but the FailedPaymentTracker route
// layers a 30-second in-flight guard on top so double-clicks return 409
// before hitting Stripe at all.
export async function retryInvoicePayment(
  stripeInvoiceId: string,
): Promise<{ status: string; amountPaid: number }> {
  const stripe = getStripeConnection();
  try {
    const invoice = await stripe.invoices.pay(stripeInvoiceId);
    return {
      status: invoice.status ?? 'unknown',
      amountPaid: invoice.amount_paid ?? 0,
    };
  } catch (err) {
    mapStripeError(err);
    // mapStripeError throws — this return is unreachable, satisfies TS.
    throw err;
  }
}
