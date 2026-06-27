// Authorized by HUB-1520 — analyticsService: getUsageAnalytics + getBillingAnalytics over billing_period_costs
// Authorized by HUB-1595 (E-BE-1 S12, CR-3) — getPortfolioMargin: per-product revenue + cost
//   aggregator with portfolio rollup + losingMoney signal. Threshold read from
//   settings.portfolio_margin_threshold_pct (HUB-1585 seed). R1 FIX: zero-revenue + non-zero
//   cost = losingMoney=true (was false in original spec — that defeated the indicator).
//   Comparison is `marginPct <= threshold` per HUB-1585 R1 B1 cascade (break-even flags).
//
// Spec note: the story description said to "call existing getBillingAnalytics" for revenue +
// cost, but that function returns only cost (mislabeled as `mrr_cents` — it's a SUM of
// total_cost_cents from billing_period_costs). Going direct to `invoices.amount_paid` for
// revenue and `billing_period_costs.total_cost_cents` for cost is cleaner.
// Authorized by HUB-47 FVL — M1: add recovery_count to BillingRow per FR-37-02

import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import { getSetting } from './adminSettings.js';

const PORTFOLIO_MARGIN_THRESHOLD_KEY = 'portfolio_margin_threshold_pct';
const PORTFOLIO_MARGIN_THRESHOLD_DEFAULT = 0.0;

const MAX_RANGE_DAYS = 90;
const MAX_LIMIT = 200;
const STALENESS_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export interface UsageAnalyticsParams {
  tenantId?: string;
  productId?: string;
  from: Date;
  to: Date;
  limit: number;
  cursor?: string;
}

export interface UsageRow {
  tenant_id: string;
  product_id: string;
  period_start: string;
  period_end: string;
  event_count: number;
  total_cost_cents: number;
}

export interface UsageAnalyticsResult {
  from: string;
  to: string;
  generated_at: string;
  stale: boolean;
  row_count: number;
  next_cursor: string | null;
  data: UsageRow[];
}

export interface BillingAnalyticsParams {
  productId: string;
  from: Date;
  to: Date;
}

export interface BillingRow {
  product_id: string;
  period: string;
  active_subscriptions: number;
  mrr_cents: number;
  freeze_count: number;
  recovery_count: number;
}

export interface BillingAnalyticsResult {
  from: string;
  to: string;
  generated_at: string;
  stale: boolean;
  row_count: number;
  next_cursor: null;
  data: BillingRow[];
}

interface UsageCursorPayload {
  period_start: string;
  tenant_id: string;
}

function encodeUsageCursor(period_start: string, tenant_id: string): string {
  return Buffer.from(JSON.stringify({ period_start, tenant_id })).toString('base64url');
}

function decodeUsageCursor(raw: string): UsageCursorPayload {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as UsageCursorPayload;
  } catch {
    throw new AppError(400, 'Invalid cursor');
  }
}

function validateRange(from: Date, to: Date): void {
  const rangeDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new AppError(400, 'Time range must not exceed 90 days');
  }
}

async function checkStaleness(from: Date): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ last_aggregated: Date | null }>(
    `SELECT MAX(aggregated_at) AS last_aggregated
       FROM billing_period_costs
      WHERE aggregated_at >= $1`,
    [from],
  );
  const lastAggregated = rows[0]?.last_aggregated;
  if (!lastAggregated) return true;
  return Date.now() - lastAggregated.getTime() > STALENESS_THRESHOLD_MS;
}

export async function getUsageAnalytics(params: UsageAnalyticsParams): Promise<UsageAnalyticsResult> {
  validateRange(params.from, params.to);

  const limit = Math.min(params.limit, MAX_LIMIT);
  const conditions: string[] = ['bpc.period_start >= $1', 'bpc.period_end <= $2'];
  const values: unknown[] = [params.from, params.to];
  let idx = 3;

  if (params.tenantId) {
    conditions.push(`bpc.tenant_id = $${idx++}`);
    values.push(params.tenantId);
  }
  if (params.productId) {
    conditions.push(`bpc.product_id = $${idx++}`);
    values.push(params.productId);
  }
  if (params.cursor) {
    const { period_start, tenant_id } = decodeUsageCursor(params.cursor);
    conditions.push(
      `(bpc.period_start, bpc.tenant_id::text) < ($${idx++}::timestamptz, $${idx++})`,
    );
    values.push(period_start, tenant_id);
  }

  const where = conditions.join(' AND ');
  const fetchLimit = limit + 1;

  const pool = getPool();
  const [{ rows }, stale] = await Promise.all([
    pool.query<UsageRow>(
      `SELECT bpc.tenant_id::text AS tenant_id,
              bpc.product_id::text AS product_id,
              bpc.period_start::text AS period_start,
              bpc.period_end::text AS period_end,
              bpc.event_count,
              bpc.total_cost_cents
         FROM billing_period_costs bpc
        WHERE ${where}
        ORDER BY bpc.period_start DESC, bpc.tenant_id DESC
        LIMIT $${idx}`,
      [...values, fetchLimit],
    ),
    checkStaleness(params.from),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const next_cursor =
    hasMore && last ? encodeUsageCursor(last.period_start, last.tenant_id) : null;

  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    generated_at: new Date().toISOString(),
    stale,
    row_count: data.length,
    next_cursor,
    data,
  };
}

export async function getBillingAnalytics(params: BillingAnalyticsParams): Promise<BillingAnalyticsResult> {
  validateRange(params.from, params.to);

  const pool = getPool();
  const [costRows, subRow, freezeRow, recoveryRow, stale] = await Promise.all([
    // MRR per period: sum total_cost_cents across all tenants for this product
    pool.query<{ period_start: string; period_end: string; mrr_cents: string }>(
      `SELECT period_start::text AS period_start,
              period_end::text AS period_end,
              SUM(total_cost_cents)::bigint AS mrr_cents
         FROM billing_period_costs
        WHERE product_id = $1
          AND period_start >= $2
          AND period_end <= $3
        GROUP BY period_start, period_end
        ORDER BY period_start DESC`,
      [params.productId, params.from, params.to],
    ),
    // Active subscription count for this product
    pool.query<{ active_subscriptions: string }>(
      `SELECT COUNT(*)::bigint AS active_subscriptions
         FROM stripe_subscriptions
        WHERE product_id = $1
          AND status = 'active'`,
      [params.productId],
    ),
    // Freeze count: join through product_registrations since licenses.product_id → product_registrations.id
    pool.query<{ freeze_count: string }>(
      `SELECT COUNT(*)::bigint AS freeze_count
         FROM licenses l
         JOIN product_registrations pr ON pr.id = l.product_id
        WHERE pr.product_id = $1
          AND l.status = 'suspended'
          AND l.reason = 'FREEZE'`,
      [params.productId],
    ),
    // Recovery count: licenses now active that were previously frozen (suspended_at set),
    // where the recovery (updated_at) falls within the queried billing period.
    pool.query<{ recovery_count: string }>(
      `SELECT COUNT(*)::bigint AS recovery_count
         FROM licenses l
         JOIN product_registrations pr ON pr.id = l.product_id
        WHERE pr.product_id = $1
          AND l.status = 'active'
          AND l.suspended_at IS NOT NULL
          AND l.updated_at >= $2
          AND l.updated_at <= $3`,
      [params.productId, params.from, params.to],
    ),
    checkStaleness(params.from),
  ]);

  const activeSubscriptions = parseInt(subRow.rows[0]?.active_subscriptions ?? '0', 10);
  const freezeCount = parseInt(freezeRow.rows[0]?.freeze_count ?? '0', 10);
  const recoveryCount = parseInt(recoveryRow.rows[0]?.recovery_count ?? '0', 10);

  const data: BillingRow[] = costRows.rows.map((row) => ({
    product_id: params.productId,
    period: row.period_start,
    active_subscriptions: activeSubscriptions,
    mrr_cents: Math.round(parseInt(row.mrr_cents ?? '0', 10)),
    freeze_count: freezeCount,
    recovery_count: recoveryCount,
  }));

  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    generated_at: new Date().toISOString(),
    stale,
    row_count: data.length,
    next_cursor: null,
    data,
  };
}

// ── HUB-1595 (CR-3): portfolio margin aggregator ──────────────────────────────

export interface PortfolioMarginParams {
  from: Date;
  to: Date;
}

export interface PortfolioMarginProduct {
  productId: string;
  productName: string;
  revenueCents: number;
  costCents: number;
  marginPct: number | null;
  losingMoney: boolean;
}

export interface PortfolioMarginRollup {
  revenueCents: number;
  costCents: number;
  marginPct: number | null;
  losingMoney: boolean;
}

export interface PortfolioMarginResult {
  from: string;
  to: string;
  generatedAt: string;
  threshold: number;
  products: PortfolioMarginProduct[];
  portfolio: PortfolioMarginRollup;
}

/**
 * HUB-1595 (CR-3): per-product revenue + cost aggregator with portfolio rollup. R1 FIX
 * for zero-revenue states + R1 B1 cascade (HUB-1585) using `<=` so break-even flags. Pure
 * compute over `invoices` (revenue) + `billing_period_costs` (cost) + `settings`
 * (threshold).
 */
export async function getPortfolioMargin(
  params: PortfolioMarginParams,
): Promise<PortfolioMarginResult> {
  validateRange(params.from, params.to);

  // Resolve threshold up-front; tolerate read failure with the default so the indicator
  // never errors the endpoint just because Redis or settings is briefly down.
  let threshold = PORTFOLIO_MARGIN_THRESHOLD_DEFAULT;
  try {
    const raw = await getSetting(PORTFOLIO_MARGIN_THRESHOLD_KEY);
    if (typeof raw === 'number') threshold = raw;
  } catch {
    /* swallow — fall back to default */
  }

  // Three parallel queries: products list + revenue per product + cost per product.
  // Avoids a LEFT JOIN cartesian; merge in JS keyed by product_id.
  const pool = getPool();
  const [productsRes, revenueRes, costRes] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM products WHERE active = true ORDER BY name ASC`,
    ),
    pool.query<{ product_id: string; revenue_cents: string }>(
      `SELECT product_id, COALESCE(SUM(amount_paid), 0)::bigint AS revenue_cents
         FROM invoices
        WHERE period_start >= $1
          AND period_end <= $2
        GROUP BY product_id`,
      [params.from, params.to],
    ),
    pool.query<{ product_id: string; cost_cents: string }>(
      `SELECT product_id, COALESCE(SUM(total_cost_cents), 0)::bigint AS cost_cents
         FROM billing_period_costs
        WHERE period_start >= $1
          AND period_end <= $2
        GROUP BY product_id`,
      [params.from, params.to],
    ),
  ]);

  const revenueByProduct = new Map<string, number>();
  for (const row of revenueRes.rows) {
    revenueByProduct.set(row.product_id, parseInt(row.revenue_cents, 10));
  }
  const costByProduct = new Map<string, number>();
  for (const row of costRes.rows) {
    costByProduct.set(row.product_id, parseInt(row.cost_cents, 10));
  }

  const products: PortfolioMarginProduct[] = productsRes.rows.map((p) => {
    const revenueCents = revenueByProduct.get(p.id) ?? 0;
    const costCents = costByProduct.get(p.id) ?? 0;
    const { marginPct, losingMoney } = computeMargin(revenueCents, costCents, threshold);
    return {
      productId: p.id,
      productName: p.name,
      revenueCents,
      costCents,
      marginPct,
      losingMoney,
    };
  });

  const totalRevenue = products.reduce((sum, p) => sum + p.revenueCents, 0);
  const totalCost = products.reduce((sum, p) => sum + p.costCents, 0);
  const rollup = computeMargin(totalRevenue, totalCost, threshold);
  const portfolio: PortfolioMarginRollup = {
    revenueCents: totalRevenue,
    costCents: totalCost,
    marginPct: rollup.marginPct,
    losingMoney: rollup.losingMoney,
  };

  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    generatedAt: new Date().toISOString(),
    threshold,
    products,
    portfolio,
  };
}

// ── HUB-1597 (CR-5): pricing scenario compute — fetch (impure) + compute (pure) split ──

const SCENARIO_LOOKBACK_DAYS = 30;
const SCENARIO_ELASTICITY_DEFAULT = -1.0; // HUB-1585 closeout: setting not seeded; hardcoded constant.

export const SCENARIO_DISCLAIMER =
  'Scenario projections are advisory only and use a constant-elasticity model. Actual outcomes depend on factors not modeled (churn timing, competitive pricing, mix shifts). This is decision support, not a forecast.';
export const SCENARIO_MODEL_TYPE = 'constant_elasticity' as const;

export interface ScenarioBaseline {
  snapshotAt: string;
  productId: string;
  revenueLast30dCents: number;
  costLast30dCents: number;
  subscriptionCount: number;
  elasticityCoefficient: number;
  marginPct: number | null;
}

export interface ScenarioInput {
  priceChangePercent: number;
  churnAssumptionPercent: number;
}

export interface ScenarioProjection {
  revenueCents: number;
  costCents: number;
  marginPct: number | null;
  subscriptionCount: number;
}

export interface ScenarioDelta {
  revenueCents: number;
  costCents: number;
  marginPctPoints: number | null;
  subscriptionCount: number;
}

export interface ScenarioResult {
  baseline: ScenarioBaseline;
  scenario: ScenarioProjection;
  delta: ScenarioDelta;
  modelType: typeof SCENARIO_MODEL_TYPE;
  disclaimer: string;
}

/**
 * HUB-1597 (CR-5) IMPURE: read live revenue + cost + subscription count for the productId
 * over the last 30 days, freeze into a baseline snapshot. The returned snapshot is the
 * boundary between impure (this fn) and pure (computeScenario) — once frozen, the same
 * baseline + input must produce byte-identical outputs forever.
 *
 * Spec deviation: R1 mentioned `pricing_models.coefficient` but the live `pricing_models`
 * table stores model config in JSONB without a coefficient column. Hardcoded -1.0 (per
 * HUB-1585 closeout — pricing_elasticity_coefficient setting was implicitly dropped).
 */
export async function fetchScenarioBaseline(productId: string): Promise<ScenarioBaseline> {
  const now = new Date();
  const from = new Date(now.getTime() - SCENARIO_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const pool = getPool();
  const [revenueRes, costRes, subRes] = await Promise.all([
    pool.query<{ revenue_cents: string }>(
      `SELECT COALESCE(SUM(amount_paid), 0)::bigint AS revenue_cents
         FROM invoices
        WHERE product_id = $1 AND period_start >= $2 AND period_end <= $3`,
      [productId, from, now],
    ),
    pool.query<{ cost_cents: string }>(
      `SELECT COALESCE(SUM(total_cost_cents), 0)::bigint AS cost_cents
         FROM billing_period_costs
        WHERE product_id = $1 AND period_start >= $2 AND period_end <= $3`,
      [productId, from, now],
    ),
    pool.query<{ sub_count: string }>(
      `SELECT COUNT(*)::bigint AS sub_count
         FROM stripe_subscriptions
        WHERE product_id = $1 AND status = 'active'`,
      [productId],
    ),
  ]);

  const revenueLast30dCents = parseInt(revenueRes.rows[0]?.revenue_cents ?? '0', 10);
  const costLast30dCents = parseInt(costRes.rows[0]?.cost_cents ?? '0', 10);
  const subscriptionCount = parseInt(subRes.rows[0]?.sub_count ?? '0', 10);

  let marginPct: number | null = null;
  if (revenueLast30dCents > 0) {
    marginPct =
      Math.round(((revenueLast30dCents - costLast30dCents) / revenueLast30dCents) * 10000) / 10000;
  }

  return {
    snapshotAt: now.toISOString(),
    productId,
    revenueLast30dCents,
    costLast30dCents,
    subscriptionCount,
    elasticityCoefficient: SCENARIO_ELASTICITY_DEFAULT,
    marginPct,
  };
}

/**
 * HUB-1597 (CR-5) PURE: deterministic compute over a frozen baseline + scenario input.
 * Same `(baseline, input)` produces byte-identical `ScenarioResult` every time — this is
 * the R1 idempotency contract.
 *
 * Math:
 *   customerCount_scenario = subCount × (1 + churn/100) × (1 + elasticity × priceChange/100)
 *   revenue_scenario       = revenue × (1 + priceChange/100) × (customerCount_scenario / subCount)
 *   cost_scenario          = cost  (held constant in v0.1 — pricing has no cost-side effect)
 *   marginPct_scenario     = (revenue_scenario - cost_scenario) / revenue_scenario
 *
 * Validation: priceChangePercent must be > -100 (can't drop price by 100% or more); churn
 * must be 0..100. Subscription count of zero produces a degenerate baseline (no customers
 * to elasticity-scale) — the scenario projects zero revenue and the same cost.
 */
export function computeScenario(baseline: ScenarioBaseline, input: ScenarioInput): ScenarioResult {
  if (input.priceChangePercent <= -100) {
    throw new AppError(400, 'priceChangePercent must be greater than -100');
  }
  if (input.churnAssumptionPercent < 0 || input.churnAssumptionPercent > 100) {
    throw new AppError(400, 'churnAssumptionPercent must be between 0 and 100');
  }

  const churnFactor = 1 + input.churnAssumptionPercent / 100;
  const elasticityFactor = 1 + baseline.elasticityCoefficient * (input.priceChangePercent / 100);
  const subscriptionScalar = churnFactor * elasticityFactor;

  let subscriptionCountScenario = 0;
  let revenueScenarioCents = 0;
  if (baseline.subscriptionCount > 0) {
    subscriptionCountScenario = Math.round(baseline.subscriptionCount * subscriptionScalar);
    const priceFactor = 1 + input.priceChangePercent / 100;
    revenueScenarioCents = Math.round(
      baseline.revenueLast30dCents * priceFactor * subscriptionScalar,
    );
  }

  const costScenarioCents = baseline.costLast30dCents; // held constant in v0.1
  const marginPctScenario =
    revenueScenarioCents > 0
      ? Math.round(((revenueScenarioCents - costScenarioCents) / revenueScenarioCents) * 10000) /
        10000
      : null;

  const scenario: ScenarioProjection = {
    revenueCents: revenueScenarioCents,
    costCents: costScenarioCents,
    marginPct: marginPctScenario,
    subscriptionCount: subscriptionCountScenario,
  };

  const delta: ScenarioDelta = {
    revenueCents: revenueScenarioCents - baseline.revenueLast30dCents,
    costCents: costScenarioCents - baseline.costLast30dCents,
    marginPctPoints:
      baseline.marginPct !== null && marginPctScenario !== null
        ? Math.round((marginPctScenario - baseline.marginPct) * 10000) / 10000
        : null,
    subscriptionCount: subscriptionCountScenario - baseline.subscriptionCount,
  };

  return {
    baseline,
    scenario,
    delta,
    modelType: SCENARIO_MODEL_TYPE,
    disclaimer: SCENARIO_DISCLAIMER,
  };
}

/**
 * HUB-1595 R1 three-branch margin logic:
 *   revenue=0, cost=0   → no signal (marginPct null, losingMoney false)
 *   revenue=0, cost>0   → burn with no revenue (marginPct null, losingMoney TRUE)
 *   revenue>0           → (revenue-cost)/revenue, compare <= threshold
 *
 * Rounds marginPct to 4-decimal precision so downstream display rounding is deterministic.
 */
function computeMargin(
  revenueCents: number,
  costCents: number,
  threshold: number,
): { marginPct: number | null; losingMoney: boolean } {
  if (revenueCents === 0 && costCents === 0) {
    return { marginPct: null, losingMoney: false };
  }
  if (revenueCents === 0 && costCents > 0) {
    return { marginPct: null, losingMoney: true };
  }
  const raw = (revenueCents - costCents) / revenueCents;
  const marginPct = Math.round(raw * 10000) / 10000;
  return { marginPct, losingMoney: marginPct <= threshold };
}
