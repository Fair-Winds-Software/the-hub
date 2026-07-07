// Authorized by HUB-1718 + HUB-1719 + HUB-1720 (E-V2-PP-1 S5/S6/S7, HUB-1713, HUB-1701) —
// LaunchKit pricing primitives service. Three pure functions on top of the migration 071
// schema:
//   - chargeOneTime(planId, quantity, opts)   → returns { amount_cents, stripe_mode }
//   - calculateVolumeLadderTotal(planId, quantity) → cumulative-tier ladder total
//   - calculateBundleDiscount(planIds, cartTotalCents) → largest applicable bundle
//
// All three read the DB only — no writes. Suitable for use in both invoice generation
// and the pricing simulator (HUB-1547 territory later).

import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

/** Shape of an entry inside the plans.volume_ladder JSONB column. */
export interface VolumeLadderTier {
  min_quantity: number;
  /** null = "and above" (unbounded upper). */
  max_quantity: number | null;
  unit_amount_cents: number;
  sort_order: number;
}

/** Row projection from plans used by the pricing services. */
interface PlanPricingRow {
  id: string;
  unit_amount_cents: number | null;
  billing_type: string;
  billing_interval: string | null;
  billing_mode: 'standard' | 'credit';
  volume_ladder: VolumeLadderTier[] | null;
}

/** Row projection from plan_bundles used by the bundle service. */
interface PlanBundleRow {
  id: string;
  member_plan_ids: string[];
  discount_type: 'flat_amount_cents' | 'percent_bps';
  discount_value: number;
}

// ─── S5: chargeOneTime ────────────────────────────────────────────────────────

export interface OneTimeChargeResult {
  amount_cents: number;
  /** 'stripe' means the caller should invoke Stripe PaymentIntent; 'credit' means
      caller must NOT touch Stripe (credit-mode invariant per HUB-1546 §6 BR-5). */
  stripe_mode: 'payment' | 'credit_only';
}

/**
 * Compute a one-time charge for a plan (LaunchKit license shape). Returns the amount
 * plus the required Stripe mode. Enforces the `billing_type='one_time'` +
 * `billing_interval` null invariant (S5 AC 2 defense-in-depth: DB may accept the
 * combo, service refuses to compute a charge).
 *
 * Throws AppError(400) on invariant violations; AppError(404) if plan missing.
 */
export async function chargeOneTime(
  planId: string,
  quantity = 1,
): Promise<OneTimeChargeResult> {
  if (quantity < 1 || !Number.isInteger(quantity)) {
    throw new AppError(400, 'quantity must be a positive integer');
  }
  const pool = getPool();
  const { rows } = await pool.query<PlanPricingRow>(
    `SELECT id, unit_amount_cents, billing_type, billing_interval, billing_mode,
            volume_ladder
       FROM plans
      WHERE id = $1`,
    [planId],
  );
  const plan = rows[0];
  if (!plan) throw new AppError(404, 'plan not found');

  if (plan.billing_type !== 'one_time') {
    throw new AppError(400, `plan ${planId} is not a one-time SKU (billing_type=${plan.billing_type})`);
  }
  if (plan.billing_interval !== null) {
    throw new AppError(400, `one-time plan must have billing_interval=null; got ${plan.billing_interval}`);
  }
  if (plan.unit_amount_cents === null) {
    throw new AppError(400, `one-time plan ${planId} missing unit_amount_cents`);
  }

  // If the plan has a volume ladder, delegate to the ladder calculator.
  const amount_cents = plan.volume_ladder && plan.volume_ladder.length > 0
    ? computeLadderTotal(plan.volume_ladder, quantity)
    : plan.unit_amount_cents * quantity;

  return {
    amount_cents,
    stripe_mode: plan.billing_mode === 'credit' ? 'credit_only' : 'payment',
  };
}

// ─── S6: calculateVolumeLadderTotal ───────────────────────────────────────────

/**
 * Cumulative-tier volume-ladder total. See HUB-1719 AC 1 for semantics:
 *   quantity=3 over tiers [1: included, 2: $500, 3+: $300]
 *   → sum = $500 (from tier "2") + $300 (from tier "3+") = $800
 * Flat pricing fallback: if no ladder exists, uses plan.unit_amount_cents × quantity.
 */
export async function calculateVolumeLadderTotal(
  planId: string,
  quantity: number,
): Promise<number> {
  if (quantity < 0 || !Number.isInteger(quantity)) {
    throw new AppError(400, 'quantity must be a non-negative integer');
  }
  if (quantity === 0) return 0;

  const pool = getPool();
  const { rows } = await pool.query<Pick<PlanPricingRow, 'unit_amount_cents' | 'volume_ladder'>>(
    `SELECT unit_amount_cents, volume_ladder FROM plans WHERE id = $1`,
    [planId],
  );
  const plan = rows[0];
  if (!plan) throw new AppError(404, 'plan not found');

  if (!plan.volume_ladder || plan.volume_ladder.length === 0) {
    return (plan.unit_amount_cents ?? 0) * quantity;
  }
  return computeLadderTotal(plan.volume_ladder, quantity);
}

/**
 * Pure computation of a ladder total. Extracted so chargeOneTime can share it
 * without a second DB round-trip.
 *
 * Semantics per HUB-1719 ACs:
 *   - quantity below the lowest tier's min_quantity → 0 cents (the "first N free" case)
 *   - unbounded highest tier (max_quantity=null) absorbs any remaining quantity
 *   - bounded highest tier + quantity beyond it → AppError(400) — bounded ladders don't extrapolate
 *   - each tier's contribution = unitsInTier × unit_amount_cents (integer math)
 */
function computeLadderTotal(ladder: VolumeLadderTier[], quantity: number): number {
  const sorted = [...ladder].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.min_quantity - b.min_quantity;
  });
  // Determine highest bounded quantity (or Infinity if the last tier is open-ended).
  const last = sorted[sorted.length - 1]!;
  const maxCovered = last.max_quantity === null ? Infinity : last.max_quantity;
  if (quantity > maxCovered) {
    throw new AppError(400, 'quantity exceeds ladder');
  }

  let total = 0;
  for (const tier of sorted) {
    if (quantity < tier.min_quantity) continue;
    const upper = tier.max_quantity ?? quantity;
    const unitsInTier = Math.max(0, Math.min(quantity, upper) - tier.min_quantity + 1);
    total += unitsInTier * tier.unit_amount_cents;
  }
  return total;
}

// ─── S7: calculateBundleDiscount ──────────────────────────────────────────────

export interface BundleDiscountResult {
  appliedBundleId: string | null;
  discountCents: number;
}

/**
 * Return the largest single bundle-discount applicable to a set of plans in a cart.
 * Semantics per HUB-1720 ACs:
 *   - a bundle applies iff all its member_plan_ids are a subset of planIds
 *   - if multiple bundles apply, the one with the largest computed discountCents wins
 *   - bundles do NOT stack (v0.2 default per HUB-1701 §6)
 *   - archived bundles are never applied
 *   - percent_bps uses floor(cart × bps / 10000) — integer floor, not round
 *   - planIds < 2 → no bundle can match
 */
export async function calculateBundleDiscount(
  planIds: string[],
  cartTotalCents: number,
): Promise<BundleDiscountResult> {
  if (planIds.length < 2) return { appliedBundleId: null, discountCents: 0 };
  if (cartTotalCents < 0) {
    throw new AppError(400, 'cartTotalCents must be non-negative');
  }

  const pool = getPool();
  // Only fetch bundles whose members overlap with the cart at all — the array-contains
  // filter uses the GIN index on member_plan_ids.
  const { rows } = await pool.query<PlanBundleRow>(
    `SELECT id, member_plan_ids, discount_type, discount_value
       FROM plan_bundles
      WHERE status = 'active'
        AND member_plan_ids <@ $1::uuid[]`,
    [planIds],
  );

  const cartSet = new Set(planIds);
  let best: BundleDiscountResult = { appliedBundleId: null, discountCents: 0 };

  for (const bundle of rows) {
    // Redundant but explicit subset check — defends against the <@ operator returning
    // a false positive on some PG edge cases.
    const allPresent = bundle.member_plan_ids.every((m) => cartSet.has(m));
    if (!allPresent) continue;

    const discountCents = bundle.discount_type === 'flat_amount_cents'
      ? bundle.discount_value
      : Math.floor((cartTotalCents * bundle.discount_value) / 10000);

    if (discountCents > best.discountCents) {
      best = { appliedBundleId: bundle.id, discountCents };
    }
  }
  return best;
}
