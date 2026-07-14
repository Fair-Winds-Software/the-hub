// Authorized by HUB-1806 (S4 of HUB-1785) — rollup service. Reads raw metric_events
// within a lookback window, groups by (product × metric × dimensions × bucket_start),
// applies the catalog-declared rollup semantic (sum/avg/max/last), and UPSERTs into
// metric_rollups. The UPSERT uses the metric_rollups_uniq_idx natural key so re-running
// a bucket idempotently overwrites the aggregate — safe under late arrivals.
//
// Time buckets:
//   hourly  → floor(occurred_at, hour)
//   daily   → floor(occurred_at, day)     — UTC day
//   monthly → floor(occurred_at, month)   — UTC month
//
// Lookback windows (default; overridable per invocation):
//   hourly  → 2 hours (recompute the last 2 buckets to absorb late arrivals)
//   daily   → 2 days
//   monthly → 2 months
//
// Value column:
//   int/float metrics  → value_num (aggregate of value_num column)
//   enum metrics       → value_str (LAST semantic — take the most-recent bucket value)
import { getPool } from '../../db/pool.js';
import logger from '../../lib/logger.js';
import { listCatalog, type RollupSemantic } from './metricCatalog.js';

export type RollupWindow = 'hourly' | 'daily' | 'monthly';

interface RollupOptions {
  window: RollupWindow;
  /** How far back to recompute. Defaults per window (see above). */
  lookback?: { unit: 'hours' | 'days' | 'months'; count: number };
  /** Override "now" for tests. */
  now?: Date;
}

interface RollupResult {
  window: RollupWindow;
  rows_upserted: number;
  metrics_processed: number;
  duration_ms: number;
}

const DEFAULT_LOOKBACK: Record<RollupWindow, { unit: 'hours' | 'days' | 'months'; count: number }> = {
  hourly: { unit: 'hours', count: 2 },
  daily: { unit: 'days', count: 2 },
  monthly: { unit: 'months', count: 2 },
};

// PG date_trunc arg per window
const TRUNC_UNIT: Record<RollupWindow, string> = {
  hourly: 'hour',
  daily: 'day',
  monthly: 'month',
};

// PG interval-string builder for the lookback window
function lookbackInterval(opts: RollupOptions): string {
  const lb = opts.lookback ?? DEFAULT_LOOKBACK[opts.window];
  return `${lb.count} ${lb.unit}`;
}

// Rollup semantic → PG aggregate SQL fragment on value_num
function numericAgg(semantic: RollupSemantic): string {
  switch (semantic) {
    case 'sum':
      return 'SUM(value_num)';
    case 'avg':
      return 'AVG(value_num)';
    case 'max':
      return 'MAX(value_num)';
    case 'last':
      // Most-recent value in the bucket (by occurred_at). Ties broken by ingested_at.
      return `(ARRAY_AGG(value_num ORDER BY occurred_at DESC, ingested_at DESC))[1]`;
    default:
      throw new Error(`unrecognized rollup semantic '${semantic as string}'`);
  }
}

// Enum metrics: only 'last' makes sense (enums don't sum/avg). Take most-recent value_str.
function enumAgg(semantic: RollupSemantic): string {
  if (semantic !== 'last') {
    // Fallback to LAST — the catalog should not declare non-last for enums, but be
    // defensive so a catalog author mistake doesn't corrupt aggregates.
    return `(ARRAY_AGG(value_str ORDER BY occurred_at DESC, ingested_at DESC))[1]`;
  }
  return `(ARRAY_AGG(value_str ORDER BY occurred_at DESC, ingested_at DESC))[1]`;
}

export async function runRollup(opts: RollupOptions): Promise<RollupResult> {
  const start = Date.now();
  const pool = getPool();
  const now = opts.now ?? new Date();
  const interval = lookbackInterval(opts);
  const truncUnit = TRUNC_UNIT[opts.window];

  let totalUpserted = 0;
  let processed = 0;

  for (const entry of listCatalog()) {
    // Skip metrics we won't aggregate for this window. All catalog metrics roll
    // hourly by default; daily/monthly are supersets. This function is called per-window
    // by the S4 BullMQ jobs.
    const isEnum = entry.type.startsWith('enum:');
    const valueExpr = isEnum ? enumAgg(entry.rollup) : numericAgg(entry.rollup);
    const valueColumn = isEnum ? 'value_str' : 'value_num';

    const sql = `
      INSERT INTO metric_rollups
        (product_id, metric_name, dimensions, bucket_window, bucket_start,
         ${valueColumn}, sample_count, computed_at)
      SELECT
        product_id,
        metric_name,
        dimensions,
        $1 AS bucket_window,
        DATE_TRUNC($2, occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
        ${valueExpr} AS value,
        COUNT(*) AS sample_count,
        $3 AS computed_at
      FROM metric_events
      WHERE metric_name = $4
        AND occurred_at >= ($3::timestamptz - $5::interval)
      GROUP BY product_id, metric_name, dimensions,
               DATE_TRUNC($2, occurred_at AT TIME ZONE 'UTC')
      ON CONFLICT (product_id, metric_name, dimensions, bucket_window, bucket_start)
      DO UPDATE SET
        ${valueColumn} = EXCLUDED.${valueColumn},
        sample_count   = EXCLUDED.sample_count,
        computed_at    = EXCLUDED.computed_at
    `;

    const result = await pool.query(sql, [opts.window, truncUnit, now, entry.name, interval]);
    totalUpserted += result.rowCount ?? 0;
    processed += 1;
  }

  const duration_ms = Date.now() - start;
  logger.info(
    { window: opts.window, rows_upserted: totalUpserted, metrics_processed: processed, duration_ms },
    'bi_rollup_complete',
  );
  return { window: opts.window, rows_upserted: totalUpserted, metrics_processed: processed, duration_ms };
}
