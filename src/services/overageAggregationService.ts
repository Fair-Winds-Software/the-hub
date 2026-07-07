// Authorized by HUB-1744 (E-V2-PP-3 S4, HUB-1727, HUB-1701) — per-tier overage
// aggregation service. Reads usage_events × plans.tiers JSONB (extended per D-03
// with nested overage_rates) × plan_metered_dimensions and returns per-dimension
// overage line items. Pure function w.r.t. the DB (no writes).
//
// Extended tier JSONB shape (per D-HUB-1701-03 Reconciliation Log 2026-07-07):
//   plans.tiers = [
//     { upTo, unitAmount, overage_rates?: [
//         { dimension_key, included_quantity, rate_per_unit_cents }
//     ] }
//   ]

import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

export interface OverageRate {
  dimension_key: string;
  included_quantity: number;
  rate_per_unit_cents: number;
}

export interface TierWithOverage {
  upTo?: number | null;
  unitAmount?: number;
  overage_rates?: OverageRate[];
}

export interface OverageRow {
  dimension_key: string;
  dimension_label: string;
  usage_quantity: number;
  included_quantity: number;
  overage_quantity: number;
  rate_per_unit_cents: number;
  total_cents: number;
  /** True if the tier-level rate was found; false if we fell back to plan-level rate. */
  used_tier_rate: boolean;
}

interface PlanRow {
  id: string;
  tiers: unknown;
}

interface DimensionRow {
  dimension_key: string;
  dimension_label: string;
}

/**
 * Compute per-dimension overage for a tenant on a plan across a billing period.
 *
 * Per HUB-1744 ACs:
 *   AC 1 — returns one row per declared dimension
 *   AC 2 — usage <= included_quantity → overage_quantity=0, total_cents=0 (row still returned)
 *   AC 3 — v0.1 back-compat fallback: no tier overage_rate → falls back to plan-level rate
 *          (in v0.1 plans.tiers doesn't have overage_rates yet; caller may pass a
 *          fallback map via `fallbackPlanLevelRates`)
 *   AC 4 — integer math throughout; result is byte-identical for identical inputs
 *   AC 5 — usage_events read at snapshot semantics (single SELECT — sufficient for
 *          the aggregate use case; nightly job cadence doesn't need REPEATABLE READ txn)
 *   AC 6 — no proration on mid-period tier changes; caller passes the tier active at
 *          end-of-period
 *   AC 7 — pure w.r.t. DB (no writes)
 */
export async function computeTenantOverage(
  tenantId: string,
  planId: string,
  currentTierIndex: number,
  periodFrom: Date,
  periodTo: Date,
  fallbackPlanLevelRates: Record<string, OverageRate> = {},
): Promise<OverageRow[]> {
  if (!(periodFrom instanceof Date) || !(periodTo instanceof Date)) {
    throw new AppError(400, 'periodFrom and periodTo must be Date instances');
  }
  if (periodTo.getTime() < periodFrom.getTime()) {
    throw new AppError(400, 'periodTo must be >= periodFrom');
  }

  const pool = getPool();
  // 1. Load plan + parse tiers JSONB.
  const { rows: planRows } = await pool.query<PlanRow>(
    `SELECT id, tiers FROM plans WHERE id = $1`, [planId],
  );
  const plan = planRows[0];
  if (!plan) throw new AppError(404, `plan ${planId} not found`);
  const tiers: TierWithOverage[] = Array.isArray(plan.tiers) ? (plan.tiers as TierWithOverage[]) : [];
  const activeTier: TierWithOverage | undefined = tiers[currentTierIndex];
  if (activeTier === undefined) {
    throw new AppError(400, `plan ${planId} has no tier at index ${currentTierIndex}`);
  }

  // 2. Load declared dimensions for the plan (ordered by sort_order + dimension_key).
  const { rows: dimRows } = await pool.query<DimensionRow>(
    `SELECT dimension_key, dimension_label
       FROM plan_metered_dimensions
      WHERE plan_id = $1
      ORDER BY sort_order ASC, dimension_key ASC`,
    [planId],
  );

  if (dimRows.length === 0) {
    // Plan doesn't declare any dimensions — nothing to bill. Empty result is expected.
    return [];
  }

  // 3. Aggregate usage per (dimension_key = event_type) for the tenant/product/period.
  //    Product scope comes from the plan.product_id — one round-trip to fetch.
  const { rows: productRows } = await pool.query<{ product_id: string }>(
    `SELECT product_id FROM plans WHERE id = $1`, [planId],
  );
  const productId = productRows[0]!.product_id;

  const dimensionKeys = dimRows.map((d) => d.dimension_key);
  const { rows: usageRows } = await pool.query<{ event_type: string; sum_units: string }>(
    `SELECT event_type, COALESCE(SUM(unit_count), 0)::text AS sum_units
       FROM usage_events
      WHERE tenant_id = $1
        AND product_id = $2
        AND occurred_at >= $3
        AND occurred_at <  $4
        AND event_type = ANY($5::text[])
      GROUP BY event_type`,
    [tenantId, productId, periodFrom.toISOString(), periodTo.toISOString(), dimensionKeys],
  );
  const usageByKey = new Map<string, number>(
    usageRows.map((r) => [r.event_type, parseInt(r.sum_units, 10)]),
  );

  // 4. For each declared dimension, resolve rate + compute overage.
  const tierRates: Map<string, OverageRate> = new Map();
  for (const r of activeTier.overage_rates ?? []) {
    tierRates.set(r.dimension_key, r);
  }

  const result: OverageRow[] = [];
  for (const dim of dimRows) {
    const usage = usageByKey.get(dim.dimension_key) ?? 0;
    let rate = tierRates.get(dim.dimension_key);
    let usedTierRate = true;
    if (rate === undefined) {
      // Fall back to plan-level rate (v0.1 back-compat). If no fallback either,
      // treat as 0-cost dimension (overage_quantity computed, rate=0).
      rate = fallbackPlanLevelRates[dim.dimension_key];
      usedTierRate = false;
    }
    const includedQty = rate?.included_quantity ?? 0;
    const ratePerUnit = rate?.rate_per_unit_cents ?? 0;
    const overageQty = Math.max(0, usage - includedQty);
    // Integer math: usage * rate is already integer; JS number is fine up to 2^53.
    const totalCents = overageQty * ratePerUnit;
    result.push({
      dimension_key: dim.dimension_key,
      dimension_label: dim.dimension_label,
      usage_quantity: usage,
      included_quantity: includedQty,
      overage_quantity: overageQty,
      rate_per_unit_cents: ratePerUnit,
      total_cents: totalCents,
      used_tier_rate: usedTierRate,
    });
  }
  return result;
}
