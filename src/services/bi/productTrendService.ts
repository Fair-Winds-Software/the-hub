// Authorized by HUB-1808 (S6 of HUB-1785) — per-product BI trend + health queries.
// Reads from metric_rollups (populated by the S4 rollup jobs). No cache — per-product
// endpoints are lower-traffic than the portfolio summary.
//
// getTrendSeries(): returns a chronological series of { bucket_start, value, sample_count }
//   for a single (product × metric × window) over a range.
// getProductHealth(): returns the most-recent hourly app_health_status rollup within
//   the last 24h. No recent rollup → 'unknown' with reason='no recent metric'.
import { getPool } from '../../db/pool.js';
import type { HealthState } from './portfolioSummaryService.js';

export type RollupWindow = 'hourly' | 'daily' | 'monthly';
export type Range = '7d' | '30d' | '90d';

export interface TrendPoint {
  bucket_start: string;
  value: number | null;
  sample_count: number;
}

export interface TrendSeries {
  product_id: string;
  metric: string;
  window: RollupWindow;
  range: Range;
  series: TrendPoint[];
}

export interface ProductHealth {
  product_id: string;
  health: HealthState;
  as_of: string;
  reason: string | null;
}

const RANGE_TO_INTERVAL: Record<Range, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

interface TrendRow {
  bucket_start: Date;
  value_num: string | null;
  sample_count: number;
}

export async function getTrendSeries(input: {
  productId: string;
  metric: string;
  window: RollupWindow;
  range: Range;
  now?: Date;
}): Promise<TrendSeries> {
  const now = input.now ?? new Date();
  const pool = getPool();
  const { rows } = await pool.query<TrendRow>(
    `SELECT bucket_start, value_num::text, sample_count
       FROM metric_rollups
      WHERE product_id = $1::uuid
        AND metric_name = $2
        AND bucket_window = $3
        AND bucket_start >= ($4::timestamptz - $5::interval)
      ORDER BY bucket_start ASC`,
    [input.productId, input.metric, input.window, now, RANGE_TO_INTERVAL[input.range]],
  );
  return {
    product_id: input.productId,
    metric: input.metric,
    window: input.window,
    range: input.range,
    series: rows.map((r) => ({
      bucket_start: r.bucket_start.toISOString(),
      value: r.value_num !== null ? Number(r.value_num) : null,
      sample_count: r.sample_count,
    })),
  };
}

interface HealthRow {
  value_str: string;
  bucket_start: Date;
}

export async function getProductHealth(input: {
  productId: string;
  now?: Date;
}): Promise<ProductHealth> {
  const now = input.now ?? new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const pool = getPool();
  const { rows } = await pool.query<HealthRow>(
    `SELECT value_str, bucket_start
       FROM metric_rollups
      WHERE product_id = $1::uuid
        AND metric_name = 'app_health_status'
        AND bucket_window = 'hourly'
        AND bucket_start >= $2
        AND value_str IS NOT NULL
      ORDER BY bucket_start DESC
      LIMIT 1`,
    [input.productId, twentyFourHoursAgo],
  );
  if (rows.length === 0) {
    return {
      product_id: input.productId,
      health: 'unknown',
      as_of: now.toISOString(),
      reason: 'no recent metric',
    };
  }
  const row = rows[0]!;
  return {
    product_id: input.productId,
    health: row.value_str as HealthState,
    as_of: row.bucket_start.toISOString(),
    reason: null,
  };
}
