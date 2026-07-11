// Authorized by HUB-1488 — schedulePlanChange(): immediate/next_cycle Stripe transitions with add-on/discount/override carry-through
// Authorized by HUB-1591 (E-BE-1 S8, CR-2) — defensive guard rejects tenant plan changes
//   crossing billing_mode in v0.1 (no compensating transactions per R1; reserved for v0.2)
// Authorized by HUB-1489 — grandfatherExistingSubscribers(): BullMQ job + idempotency guard
// Authorized by HUB-1490 — getPlanChangeHistory(): ledger read
// Authorized by HUB-1491 — confirmPlanChange(): webhook-driven applied_at confirmation
import type Stripe from 'stripe';
import { isCreditMode } from './stripeService.js';
import { getPool } from '../db/pool.js';
import { mapStripeError } from '../stripe/client.js';
import { getStripeConnection } from '../stripe/registry.js';
import { getCurrentOverride } from './priceOverrideService.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

export interface PlanChangeLedgerRow {
  id: string;
  product_id: string;
  tenant_id: string;
  plan_id: string;
  effective_date: string;
  effective_at: Date;
  audit_note: string | null;
  discount_percent: number | null;
  price_overrides: Record<string, unknown>;
  applied_by: string | null;
  created_at: Date;
  delta_data: unknown | null;
  stripe_schedule_id: string | null;
  grandfathered: boolean;
  protection_expires_at: Date | null;
  target_stripe_price_id: string | null;
  applied_at: Date | null;
  old_plan_id: string | null;
  reason: string | null;
}

export type PlanChangeEffectiveFrom = 'immediate' | 'next_cycle';

interface BillingRecurring {
  interval: 'day' | 'week' | 'month' | 'year';
  interval_count?: number;
}

const INTERVAL_MAP: Record<string, BillingRecurring> = {
  month:    { interval: 'month' },
  quarter:  { interval: 'month', interval_count: 3 },
  year:     { interval: 'year' },
  one_time: { interval: 'month' },
};

// Schedules a tenant plan change for immediate or next-cycle application.
// Carries active add-ons, discounts, and price overrides through the transition.
// Inserts a plan_change_ledger row after all Stripe calls succeed (Stripe-then-DB ordering).
export async function schedulePlanChange(
  tenantId: string,
  productId: string,
  targetPlanId: string,
  effectiveFrom: PlanChangeEffectiveFrom,
  reason: string,
  appliedBy?: string,
): Promise<PlanChangeLedgerRow> {
  const pool = getPool();

  const { rows: planRows } = await pool.query<{
    id: string;
    stripe_price_id: string;
    stripe_product_id: string;
    billing_interval: string;
  }>(
    'SELECT id, stripe_price_id, stripe_product_id, billing_interval FROM plans WHERE id = $1 AND active = true',
    [targetPlanId],
  );
  if (!planRows[0]) throw new AppError(404, 'Target plan not found or inactive');
  const plan = planRows[0];

  const { rows: subRows } = await pool.query<{
    stripe_subscription_id: string;
    stripe_price_id: string;
    current_period_end: Date;
    plan_id: string | null;
  }>(
    `SELECT stripe_subscription_id, stripe_price_id, current_period_end, plan_id
     FROM stripe_subscriptions
     WHERE tenant_id = $1 AND product_id = $2 AND status = 'active'`,
    [tenantId, productId],
  );
  if (!subRows[0]) throw new AppError(400, 'No active subscription for tenant');
  const sub = subRows[0];

  // HUB-1591 (CR-2) v0.1 limitation: tenant subscription changes across billing_mode are NOT
  // supported. R1 explicitly defers compensating transactions (Stripe cancel + internal create,
  // or vice versa) to v0.2. We reject EITHER (a) target plan is credit-mode, OR (b) the existing
  // subscription is already on the internal-credit path (synthetic stripe_subscription_id).
  // Operators handle the transition manually by cancelling the existing subscription and
  // creating a new one against the target plan.
  if (await isCreditMode(targetPlanId)) {
    throw new AppError(
      400,
      'Tenant plan changes to a credit-mode plan are not supported in v0.1. Cancel the existing subscription and create a new one against the target plan via the credit-mode flow.',
    );
  }
  if (sub.stripe_subscription_id.startsWith('internal:credit:')) {
    throw new AppError(
      400,
      'Tenant plan changes FROM a credit-mode (internal) subscription are not supported in v0.1. Cancel the existing internal subscription and create a new one against the target plan.',
    );
  }

  // Resolve price override: use inline price_data if active override exists
  const override = await getCurrentOverride(tenantId, productId, targetPlanId);
  const recurringConfig: BillingRecurring =
    INTERVAL_MAP[plan.billing_interval] ?? { interval: 'month' as const };

  // Active add-ons for carry-through
  const { rows: addOnRows } = await pool.query<{ stripe_price_id: string }>(
    `SELECT a.stripe_price_id
     FROM tenant_add_ons ta
     JOIN add_ons a ON a.id = ta.add_on_id
     WHERE ta.tenant_id = $1 AND ta.product_id = $2 AND ta.status = 'active'`,
    [tenantId, productId],
  );

  // Active discount coupon for carry-through
  const { rows: discountRows } = await pool.query<{ stripe_coupon_id: string }>(
    `SELECT d.stripe_coupon_id
     FROM tenant_discounts td
     JOIN discounts d ON d.id = td.discount_id
     WHERE td.tenant_id = $1 AND td.product_id = $2 AND td.removed_at IS NULL
     LIMIT 1`,
    [tenantId, productId],
  );
  const couponId = discountRows[0]?.stripe_coupon_id ?? null;

  const stripe = getStripeConnection();
  let stripeScheduleId: string | null = null;
  let appliedAt: Date | null = null;

  try {
    if (effectiveFrom === 'immediate') {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      const existingItemId = stripeSub.items.data[0]?.id;

      const mainItem: Stripe.SubscriptionUpdateParams.Item = override
        ? {
            id: existingItemId,
            price_data: {
              unit_amount: override.override_price_cents,
              currency: 'usd',
              product: plan.stripe_product_id,
              recurring: recurringConfig,
            },
          }
        : { id: existingItemId, price: plan.stripe_price_id };

      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [mainItem],
        proration_behavior: 'create_prorations',
      });

      appliedAt = new Date();
    } else {
      // next_cycle: create a subscription schedule to transition at period end
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.stripe_subscription_id,
      });
      stripeScheduleId = schedule.id;

      const periodEndTs = Math.floor(new Date(sub.current_period_end).getTime() / 1000);

      // Phase 1 items: mirror the auto-created phase from the existing subscription
      const phase1Items: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] =
        (schedule.phases[0]?.items ?? []).map((item) => ({
          price: typeof item.price === 'string' ? item.price : (item.price as Stripe.Price).id,
          quantity: item.quantity ?? 1,
        }));

      // Phase 2 items: new plan + all active add-ons
      const phase2MainItem: Stripe.SubscriptionScheduleUpdateParams.Phase.Item = override
        ? {
            price_data: {
              unit_amount: override.override_price_cents,
              currency: 'usd',
              product: plan.stripe_product_id,
              recurring: recurringConfig as Stripe.SubscriptionScheduleUpdateParams.Phase.Item.PriceData.Recurring,
            },
          }
        : { price: plan.stripe_price_id };

      const phase2Items: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [
        phase2MainItem,
        ...addOnRows.map((r) => ({ price: r.stripe_price_id, quantity: 1 })),
      ];

      const phase2: Stripe.SubscriptionScheduleUpdateParams.Phase = {
        items: phase2Items,
        start_date: periodEndTs,
        ...(couponId ? { coupon: couponId } : {}),
      };

      await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: 'release',
        phases: [
          { items: phase1Items, end_date: periodEndTs },
          phase2,
        ] as unknown as import('../stripe/connection.js').UpdateSubscriptionScheduleInput['phases'],
      });
    }
  } catch (err) {
    mapStripeError(err);
    throw err;
  }

  const { rows } = await pool.query<PlanChangeLedgerRow>(
    `INSERT INTO plan_change_ledger
       (tenant_id, product_id, plan_id, old_plan_id, target_stripe_price_id,
        effective_date, effective_at, reason, applied_by, stripe_schedule_id, applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9, $10)
     RETURNING *`,
    [
      tenantId,
      productId,
      targetPlanId,
      sub.plan_id ?? null,
      override ? null : plan.stripe_price_id,
      effectiveFrom,
      reason,
      appliedBy ?? null,
      stripeScheduleId,
      appliedAt,
    ],
  );

  return rows[0]!;
}

// Grandfathers all active subscribers on an archived plan.
// Inserts plan_change_ledger rows with grandfathered=true and protection_expires_at=current_period_end.
// Idempotent: skips subscribers that already have a grandfathered row for this plan.
// Called by the BullMQ 'grandfather-subscribers' job enqueued by archivePlan().
export async function grandfatherExistingSubscribers(planId: string): Promise<number> {
  const pool = getPool();

  const { rows: planRows } = await pool.query<{ stripe_price_id: string }>(
    'SELECT stripe_price_id FROM plans WHERE id = $1',
    [planId],
  );
  if (!planRows[0]) throw new AppError(404, 'Plan not found');

  const { rows: subscribers } = await pool.query<{
    tenant_id: string;
    product_id: string;
    current_period_end: Date;
  }>(
    `SELECT tenant_id, product_id, current_period_end
     FROM stripe_subscriptions
     WHERE stripe_price_id = $1 AND status = 'active'`,
    [planRows[0].stripe_price_id],
  );

  if (subscribers.length === 0) {
    logger.info({ planId, count: 0 }, 'grandfatherExistingSubscribers complete');
    return 0;
  }

  const params: unknown[] = [planId, 'Plan archived — grandfathered at renewal date'];
  const valuesSql = subscribers
    .map((s) => {
      params.push(s.tenant_id, s.product_id, s.current_period_end);
      const tIdx = params.length - 2;
      const pIdx = params.length - 1;
      const eIdx = params.length;
      return `($${tIdx}::uuid, $${pIdx}::uuid, $${eIdx}::timestamptz)`;
    })
    .join(', ');

  const { rowCount } = await pool.query(
    `INSERT INTO plan_change_ledger
       (tenant_id, product_id, plan_id, old_plan_id, effective_date, effective_at,
        grandfathered, protection_expires_at, applied_at, reason)
     SELECT v.tenant_id, v.product_id, $1, $1, 'next_cycle', NOW(), true, v.current_period_end, NULL, $2
     FROM (VALUES ${valuesSql}) AS v(tenant_id, product_id, current_period_end)
     WHERE NOT EXISTS (
       SELECT 1 FROM plan_change_ledger pcl
       WHERE pcl.tenant_id = v.tenant_id
         AND pcl.product_id = v.product_id
         AND pcl.old_plan_id = $1
         AND pcl.grandfathered = true
     )`,
    params,
  );

  const count = rowCount ?? 0;
  logger.info({ planId, count }, 'grandfatherExistingSubscribers complete');
  return count;
}

// Returns the full plan change history for a tenant-product pair, ordered newest-first.
// Includes pending (applied_at IS NULL), grandfathered, and applied rows.
const LEDGER_COLS = `id, product_id, tenant_id, plan_id, effective_date, effective_at, audit_note,
  discount_percent, price_overrides, applied_by, created_at, delta_data, stripe_schedule_id,
  grandfathered, protection_expires_at, target_stripe_price_id, applied_at, old_plan_id, reason`;

const HISTORY_MAX_LIMIT = 200;

export async function getPlanChangeHistory(
  tenantId: string,
  productId: string,
  limit?: number,
): Promise<PlanChangeLedgerRow[]> {
  const pool = getPool();
  const safeLimit = Math.min(limit ?? HISTORY_MAX_LIMIT, HISTORY_MAX_LIMIT);
  const { rows } = await pool.query<PlanChangeLedgerRow>(
    `SELECT ${LEDGER_COLS} FROM plan_change_ledger
     WHERE tenant_id = $1 AND product_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [tenantId, productId, safeLimit],
  );
  return rows;
}

// Confirms a pending plan change by setting applied_at and updating stripe_subscriptions.plan_id.
// Called by the BullMQ 'confirm-plan-change' job enqueued by handleSubscriptionUpdated().
export async function confirmPlanChange(
  tenantId: string,
  productId: string,
  newStripePriceId: string,
): Promise<void> {
  if (!tenantId || !productId || !newStripePriceId) return;

  const pool = getPool();

  const { rows } = await pool.query<PlanChangeLedgerRow>(
    `SELECT * FROM plan_change_ledger
     WHERE tenant_id = $1 AND product_id = $2 AND applied_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, productId],
  );

  const pending = rows[0];
  if (!pending) return;

  if (pending.target_stripe_price_id !== newStripePriceId) {
    logger.warn(
      { tenantId, productId, newStripePriceId, target: pending.target_stripe_price_id },
      'confirmPlanChange: price ID mismatch — skipping',
    );
    return;
  }

  await pool.query(
    'UPDATE plan_change_ledger SET applied_at = NOW() WHERE id = $1',
    [pending.id],
  );

  const { rows: planRows } = await pool.query<{ id: string }>(
    'SELECT id FROM plans WHERE stripe_price_id = $1',
    [newStripePriceId],
  );
  if (planRows[0]) {
    await pool.query(
      'UPDATE stripe_subscriptions SET plan_id = $1 WHERE tenant_id = $2 AND product_id = $3',
      [planRows[0].id, tenantId, productId],
    );
  }
}
