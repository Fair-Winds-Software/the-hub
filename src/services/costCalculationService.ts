// Authorized by HUB-685 — calculateCost() pure function + getCurrentPeriodCost, getPeriodCostHistory, getMarginSummary query helpers
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import { getActivePricingModel } from './pricingModelService.js';
import type { BillingPeriodCostRow } from './billingPeriodCostService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TierBreakdown {
  tier_order: number;
  units: number;
  unit_price_cents: number;
  cost_cents: number;
}

export interface CostResult {
  cost_cents: number;
  breakdown?: TierBreakdown[];
}

export interface CurrentPeriodCost {
  total_cost_cents: number;
  unit_count: number;
  event_count: number;
}

export interface MarginEvaluationRow {
  id: string;
  tenant_id: string;
  product_id: string;
  evaluated_at: Date;
  revenue_cents: number;
  cost_cents: number;
  margin_percentage: number;
  below_floor: boolean;
}

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

export async function calculateCost(productId: string, unitCount: number): Promise<CostResult> {
  assertUUID(productId, 'productId');
  if (unitCount < 0) throw new AppError(400, 'unitCount must be non-negative');

  const model = await getActivePricingModel(productId);
  if (!model) throw new AppError(404, 'No active pricing model for product');

  if (unitCount === 0) return { cost_cents: 0 };

  switch (model.model_type) {
    case 'flat_rate': {
      return { cost_cents: model.config.price_cents as number };
    }
    case 'usage_based': {
      return { cost_cents: unitCount * (model.config.unit_price_cents as number) };
    }
    case 'per_seat': {
      return { cost_cents: unitCount * (model.config.seat_price_cents as number) };
    }
    case 'tiered': {
      const tiers = model.tiers ?? [];
      const sorted = [...tiers].sort((a, b) => a.tier_order - b.tier_order);
      let remaining = unitCount;
      let consumed = 0;
      let totalCost = 0;
      const breakdown: TierBreakdown[] = [];

      for (const tier of sorted) {
        if (remaining <= 0) break;
        const tierMax = tier.up_to_units ?? Infinity;
        const tierCapacity = tierMax - consumed;
        const unitsInTier = Math.min(remaining, tierCapacity);
        const tierCost = unitsInTier * tier.unit_price_cents;
        totalCost += tierCost;
        breakdown.push({
          tier_order: tier.tier_order,
          units: unitsInTier,
          unit_price_cents: tier.unit_price_cents,
          cost_cents: tierCost,
        });
        consumed += unitsInTier;
        remaining -= unitsInTier;
      }

      return { cost_cents: totalCost, breakdown };
    }
    default:
      throw new AppError(400, `Unknown pricing model type: ${model.model_type}`);
  }
}

export async function getCurrentPeriodCost(
  tenantId: string,
  productId: string,
  periodStart: Date,
): Promise<CurrentPeriodCost> {
  assertUUID(tenantId, 'tenantId');
  assertUUID(productId, 'productId');

  const pool = getPool();
  const { rows } = await pool.query<{
    total_cost_cents: string;
    unit_count: string;
    event_count: string;
  }>(
    `SELECT COALESCE(SUM(cost_cents), 0) AS total_cost_cents,
            COALESCE(SUM(unit_count), 0) AS unit_count,
            COUNT(*) AS event_count
       FROM cost_ledger
      WHERE tenant_id  = $1
        AND product_id = $2
        AND occurred_at >= $3`,
    [tenantId, productId, periodStart],
  );

  const row = rows[0]!;
  return {
    total_cost_cents: parseInt(row.total_cost_cents, 10),
    unit_count: parseInt(row.unit_count, 10),
    event_count: parseInt(row.event_count, 10),
  };
}

export async function getPeriodCostHistory(
  tenantId: string,
  productId: string,
  periodStart?: Date,
  periodEnd?: Date,
): Promise<BillingPeriodCostRow[]> {
  assertUUID(tenantId, 'tenantId');
  assertUUID(productId, 'productId');

  const pool = getPool();
  const params: unknown[] = [tenantId, productId];
  let sql = `SELECT tenant_id, product_id, period_start, period_end,
                    total_units, total_cost_cents, event_count, late_event_count, aggregated_at
               FROM billing_period_costs
              WHERE tenant_id  = $1
                AND product_id = $2`;

  if (periodStart) {
    params.push(periodStart);
    sql += ` AND period_start >= $${params.length}`;
  }
  if (periodEnd) {
    params.push(periodEnd);
    sql += ` AND period_end <= $${params.length}`;
  }
  sql += ` ORDER BY period_start DESC`;

  const { rows } = await pool.query<BillingPeriodCostRow>(sql, params);
  return rows;
}

export async function getMarginSummary(
  tenantId: string,
  productId: string,
): Promise<MarginEvaluationRow[]> {
  assertUUID(tenantId, 'tenantId');
  assertUUID(productId, 'productId');

  const pool = getPool();
  const { rows } = await pool.query<MarginEvaluationRow>(
    `SELECT id, tenant_id, product_id, evaluated_at, revenue_cents, cost_cents,
            margin_percentage, below_floor
       FROM margin_evaluations
      WHERE tenant_id  = $1
        AND product_id = $2
      ORDER BY evaluated_at DESC
      LIMIT 5`,
    [tenantId, productId],
  );
  return rows;
}
