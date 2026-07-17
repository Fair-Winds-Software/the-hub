// Authorized by HUB-1807 (S5 of HUB-1785) — portfolio-wide BI summary. Reads the most
// recent daily rollups for the three headline metrics (mrr_cents / daily_active_users /
// churn_rate) + the most recent hourly app_health_status per product. Aggregates:
//   - MRR portfolio total   = SUM of most-recent daily mrr_cents per product
//   - DAU portfolio total   = SUM of most-recent daily DAU per product
//   - Churn portfolio rate  = DAU-weighted average of per-product churn_rate
//   - per_product[]         = one row per product with name + those three metrics + health
//
// The rollup layer's UPSERT contract means "most recent daily bucket" is a single point
// query per (product × metric); no windowing math here.
//
// Missing data behavior (S5 AC#5):
//   - No rollups at all → all top-level values null, per_product: [], as_of pointing to now.
//   - Product has no daily rollup for a metric → that metric is null in per_product[] and
//     is excluded from the portfolio sum for that metric.
import { getPool } from '../../db/pool.js';

export type HealthState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface PortfolioProductSummary {
  product_id: string;
  name: string;
  mrr_cents: number | null;
  dau: number | null;
  churn_rate: number | null;
  active_customers: number | null;
  health: HealthState;
}

export interface PortfolioSummary {
  as_of: string;
  mrr_cents: number | null;
  /** MRR × 12. Null when MRR is null. */
  arr_cents: number | null;
  /** MRR ÷ active_customers. Null when either input is null / zero. */
  arpa_cents: number | null;
  /** (1 / churn_rate) × ARPA. Null when churn is 0 or ARPA is null. */
  clv_cents: number | null;
  /** (this_MRR − prev_MRR) / prev_MRR. `null` when we don't have a prior bucket. */
  revenue_growth_pct: number | null;
  /** Portfolio total of the most-recent per-product active_customers rollup. */
  active_customers: number | null;
  daily_active_users: number | null;
  churn_rate: number | null;
  per_product: PortfolioProductSummary[];
}

const HEADLINE_METRICS = [
  'mrr_cents',
  'daily_active_users',
  'churn_rate',
  'active_customers',
] as const;
type HeadlineMetric = (typeof HEADLINE_METRICS)[number];

interface DailyRollupRow {
  product_id: string;
  metric_name: HeadlineMetric;
  value_num: string; // pg numeric arrives as string
  bucket_start: Date;
}

interface HealthRollupRow {
  product_id: string;
  value_str: string;
  bucket_start: Date;
}

interface ProductRow {
  id: string;
  name: string;
}

export async function computePortfolioSummary(now: Date = new Date()): Promise<PortfolioSummary> {
  const pool = getPool();

  // Fetch every product (portfolio scope).
  const { rows: products } = await pool.query<ProductRow>(
    `SELECT id::text, name FROM products`,
  );

  // Fetch most-recent daily rollup per (product, metric) for the three headline metrics.
  const { rows: dailyRows } = await pool.query<DailyRollupRow>(
    `SELECT DISTINCT ON (product_id, metric_name)
            product_id::text, metric_name, value_num::text, bucket_start
       FROM metric_rollups
      WHERE bucket_window = 'daily'
        AND metric_name = ANY($1::text[])
        AND value_num IS NOT NULL
      ORDER BY product_id, metric_name, bucket_start DESC`,
    [HEADLINE_METRICS as readonly string[]],
  );

  // Fetch most-recent hourly app_health_status per product, within last 24h.
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { rows: healthRows } = await pool.query<HealthRollupRow>(
    `SELECT DISTINCT ON (product_id)
            product_id::text, value_str, bucket_start
       FROM metric_rollups
      WHERE bucket_window = 'hourly'
        AND metric_name = 'app_health_status'
        AND value_str IS NOT NULL
        AND bucket_start >= $1
      ORDER BY product_id, bucket_start DESC`,
    [twentyFourHoursAgo],
  );

  const healthByProduct = new Map(healthRows.map((r) => [r.product_id, r.value_str]));
  const perMetric = new Map<string, Map<string, DailyRollupRow>>();
  for (const m of HEADLINE_METRICS) perMetric.set(m, new Map());
  let mostRecentBucket: Date | null = null;
  for (const row of dailyRows) {
    perMetric.get(row.metric_name)!.set(row.product_id, row);
    if (!mostRecentBucket || row.bucket_start > mostRecentBucket) {
      mostRecentBucket = row.bucket_start;
    }
  }

  const perProduct: PortfolioProductSummary[] = products.map((p) => {
    const mrr = perMetric.get('mrr_cents')!.get(p.id);
    const dau = perMetric.get('daily_active_users')!.get(p.id);
    const churn = perMetric.get('churn_rate')!.get(p.id);
    const customers = perMetric.get('active_customers')!.get(p.id);
    const health = healthByProduct.get(p.id);
    return {
      product_id: p.id,
      name: p.name,
      mrr_cents: mrr ? Number(mrr.value_num) : null,
      dau: dau ? Number(dau.value_num) : null,
      churn_rate: churn ? Number(churn.value_num) : null,
      active_customers: customers ? Number(customers.value_num) : null,
      health: (health as HealthState | undefined) ?? 'unknown',
    };
  });

  // Portfolio totals — SUM for MRR + DAU + active_customers (null-safe); DAU-weighted average for churn.
  let mrrTotal: number | null = null;
  let dauTotal: number | null = null;
  let customersTotal: number | null = null;
  let churnWeightedNumerator = 0;
  let churnWeightedDenominator = 0;
  for (const p of perProduct) {
    if (p.mrr_cents !== null) mrrTotal = (mrrTotal ?? 0) + p.mrr_cents;
    if (p.dau !== null) dauTotal = (dauTotal ?? 0) + p.dau;
    if (p.active_customers !== null) {
      customersTotal = (customersTotal ?? 0) + p.active_customers;
    }
    if (p.churn_rate !== null && p.dau !== null && p.dau > 0) {
      churnWeightedNumerator += p.churn_rate * p.dau;
      churnWeightedDenominator += p.dau;
    }
  }
  const churnPortfolio =
    churnWeightedDenominator > 0 ? churnWeightedNumerator / churnWeightedDenominator : null;

  // Derived metrics.
  const arrTotal = mrrTotal !== null ? mrrTotal * 12 : null;
  const arpaTotal =
    mrrTotal !== null && customersTotal !== null && customersTotal > 0
      ? mrrTotal / customersTotal
      : null;
  const clvTotal =
    arpaTotal !== null && churnPortfolio !== null && churnPortfolio > 0
      ? arpaTotal / churnPortfolio
      : null;

  // Revenue growth — compare current MRR portfolio total to the previous daily bucket
  // (30 days before `mostRecentBucket`). Uses a SUM across all products with an
  // mrr_cents rollup in that prior bucket. Null when we don't have a prior bucket
  // OR when the prior sum is 0 (undefined division).
  let revenueGrowthPct: number | null = null;
  if (mrrTotal !== null && mostRecentBucket) {
    const priorTarget = new Date(mostRecentBucket.getTime() - 30 * 24 * 60 * 60 * 1000);
    const priorWindowStart = new Date(priorTarget.getTime() - 24 * 60 * 60 * 1000);
    const priorWindowEnd = new Date(priorTarget.getTime() + 24 * 60 * 60 * 1000);
    const { rows: priorRows } = await pool.query<{ sum: string | null }>(
      `SELECT SUM(value_num)::text AS sum
         FROM (
           SELECT DISTINCT ON (product_id)
                  product_id, value_num
             FROM metric_rollups
            WHERE bucket_window = 'daily'
              AND metric_name = 'mrr_cents'
              AND value_num IS NOT NULL
              AND bucket_start BETWEEN $1 AND $2
            ORDER BY product_id, bucket_start DESC
         ) prior`,
      [priorWindowStart, priorWindowEnd],
    );
    const priorSum = priorRows[0]?.sum ? Number(priorRows[0].sum) : null;
    if (priorSum !== null && priorSum > 0) {
      revenueGrowthPct = (mrrTotal - priorSum) / priorSum;
    }
  }

  return {
    as_of: (mostRecentBucket ?? now).toISOString(),
    mrr_cents: mrrTotal,
    arr_cents: arrTotal,
    arpa_cents: arpaTotal,
    clv_cents: clvTotal,
    revenue_growth_pct: revenueGrowthPct,
    active_customers: customersTotal,
    daily_active_users: dauTotal,
    churn_rate: churnPortfolio,
    per_product: perProduct,
  };
}
