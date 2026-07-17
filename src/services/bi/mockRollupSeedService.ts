// Dev-only seeder for the BI Layer's metric_rollups table. Populates a
// synthetic 30-day history for the first N products in the DB so the
// Dashboard's BiTileCluster + per-product BI drill-ins show real numbers
// during a demo / tour, without requiring products to actually push events
// through POST /admin/bi/metrics.
//
// Seeded metrics per product per day:
//   mrr_cents          — linear growth from $10k → $15k over 30 days
//                        (drives Revenue Growth (30d) ≈ +50%)
//   daily_active_users — deterministic wave (baseline + product-specific offset)
//   churn_rate         — spread across products so verdicts hit healthy/warn/error
//   active_customers   — proportional to MRR, staggered per product
//   app_health_status  — hourly ok values for the last 24h
//
// Idempotent: UPSERT via the existing metric_rollups_uniq_idx. Re-running
// updates rows in place, never duplicates.
import { getPool } from '../../db/pool.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeedRollupsResult {
  products_touched: number;
  rollups_upserted: number;
  days_seeded: number;
}

interface ProductRow {
  id: string;
}

export async function seedMockRollups(options: {
  product_limit?: number;
  days?: number;
  now?: Date;
}): Promise<SeedRollupsResult> {
  const productLimit = options.product_limit ?? 10;
  const days = options.days ?? 30;
  const now = options.now ?? new Date();
  const pool = getPool();

  // Grab the first N products (deterministic ordering — smallest id first).
  const { rows: products } = await pool.query<ProductRow>(
    `SELECT id::text FROM products ORDER BY id LIMIT $1`,
    [productLimit],
  );

  if (products.length === 0) {
    return { products_touched: 0, rollups_upserted: 0, days_seeded: 0 };
  }

  const startBucket = new Date(now.getTime() - (days - 1) * DAY_MS);
  // Snap each bucket to UTC midnight so the daily rollup query matches.
  startBucket.setUTCHours(0, 0, 0, 0);

  const mrrRows: Array<[string, number, Date]> = [];
  const dauRows: Array<[string, number, Date]> = [];
  const churnRows: Array<[string, number, Date]> = [];
  const customersRows: Array<[string, number, Date]> = [];

  products.forEach((product, productIdx) => {
    for (let dayIdx = 0; dayIdx < days; dayIdx++) {
      const bucket = new Date(startBucket.getTime() + dayIdx * DAY_MS);
      const dayFraction = dayIdx / Math.max(1, days - 1); // 0 → 1 over the window

      // MRR: $10k → $15k linear per product, offset per product so portfolio total is meaningful.
      const productBaseMrr = 1_000_000 + productIdx * 250_000; // cents, ~$10k + $2.5k per product
      const mrrGrowth = productBaseMrr * (1 + 0.5 * dayFraction); // +50% end of window
      mrrRows.push([product.id, Math.round(mrrGrowth), bucket]);

      // DAU: base 500 + wave modulation + product offset
      const dauBase = 500 + productIdx * 120;
      const dauWave = Math.round(dauBase * (1 + 0.15 * Math.sin(dayIdx * 0.7)));
      dauRows.push([product.id, dauWave, bucket]);

      // Churn: spread across products (products 0-3 healthy, 4-6 warning, 7+ error)
      const churnBase =
        productIdx < 4 ? 0.015 : productIdx < 7 ? 0.035 : 0.062;
      const churnJitter = churnBase + (dayFraction - 0.5) * 0.005;
      churnRows.push([product.id, Number(churnJitter.toFixed(4)), bucket]);

      // Active customers: proportional to MRR / 5000c (~$50 ARPA target)
      const customers = Math.round(mrrGrowth / 5_000);
      customersRows.push([product.id, customers, bucket]);
    }
  });

  const totalRows =
    mrrRows.length + dauRows.length + churnRows.length + customersRows.length;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertNumericRollups(client, 'mrr_cents', mrrRows);
    await upsertNumericRollups(client, 'daily_active_users', dauRows);
    await upsertNumericRollups(client, 'churn_rate', churnRows);
    await upsertNumericRollups(client, 'active_customers', customersRows);

    // Hourly app_health_status for the last 24h so the per-product health badge lights up.
    const hourly: Array<[string, string, Date]> = [];
    const healthPattern = ['ok', 'ok', 'ok', 'degraded', 'ok', 'ok', 'ok', 'ok', 'ok', 'down'];
    products.forEach((product, productIdx) => {
      for (let h = 0; h < 24; h++) {
        const bucket = new Date(now.getTime() - h * 60 * 60 * 1000);
        bucket.setUTCMinutes(0, 0, 0);
        const value = healthPattern[(productIdx + h) % healthPattern.length]!;
        hourly.push([product.id, value, bucket]);
      }
    });
    await upsertEnumRollups(client, 'app_health_status', 'hourly', hourly);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    products_touched: products.length,
    rollups_upserted: totalRows + products.length * 24,
    days_seeded: days,
  };
}

async function upsertNumericRollups(
  client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;
  },
  metricName: string,
  rows: Array<[string, number, Date]>,
): Promise<void> {
  if (rows.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach(([productId, value, bucket], idx) => {
    const base = idx * 3;
    values.push(`($${base + 1}::uuid, $${base + 2}::numeric, $${base + 3}::timestamptz)`);
    params.push(productId, value, bucket);
  });
  await client.query(
    `INSERT INTO metric_rollups
       (product_id, metric_name, dimensions, bucket_window, bucket_start, value_num, sample_count)
     SELECT
       v.product_id, $${params.length + 1}::text, '{}'::jsonb, 'daily', v.bucket_start,
       v.value_num, 1
     FROM (VALUES ${values.join(',')}) AS v(product_id, value_num, bucket_start)
     ON CONFLICT (product_id, metric_name, dimensions, bucket_window, bucket_start)
     DO UPDATE SET value_num = EXCLUDED.value_num, computed_at = NOW()`,
    [...params, metricName],
  );
}

async function upsertEnumRollups(
  client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;
  },
  metricName: string,
  window: 'hourly' | 'daily',
  rows: Array<[string, string, Date]>,
): Promise<void> {
  if (rows.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach(([productId, value, bucket], idx) => {
    const base = idx * 3;
    values.push(`($${base + 1}::uuid, $${base + 2}::text, $${base + 3}::timestamptz)`);
    params.push(productId, value, bucket);
  });
  await client.query(
    `INSERT INTO metric_rollups
       (product_id, metric_name, dimensions, bucket_window, bucket_start, value_str, sample_count)
     SELECT
       v.product_id, $${params.length + 1}::text, '{}'::jsonb, $${params.length + 2}::text, v.bucket_start,
       v.value_str, 1
     FROM (VALUES ${values.join(',')}) AS v(product_id, value_str, bucket_start)
     ON CONFLICT (product_id, metric_name, dimensions, bucket_window, bucket_start)
     DO UPDATE SET value_str = EXCLUDED.value_str, computed_at = NOW()`,
    [...params, metricName, window],
  );
}

export async function clearMockRollups(): Promise<{ deleted: number }> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM metric_rollups
      WHERE metric_name IN ('mrr_cents', 'daily_active_users', 'churn_rate', 'active_customers', 'app_health_status')`,
  );
  return { deleted: rowCount ?? 0 };
}
