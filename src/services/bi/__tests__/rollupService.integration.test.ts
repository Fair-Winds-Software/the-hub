// Authorized by HUB-1806 (S4 of HUB-1785) — integration test for runRollup(). Seeds
// metric_events with a mix of int / float / enum metrics across two hourly buckets,
// runs runRollup({ window: 'hourly' }), and asserts:
//   - one row per (product × metric × bucket) UPSERTed into metric_rollups
//   - int/sum metric aggregates via SUM(value_num) — 3 rows of value=10 → 30
//   - float/avg metric aggregates via AVG — [0.02, 0.04, 0.06] → 0.04
//   - int/last metric aggregates via ARRAY_AGG(...ORDER BY occurred_at DESC)[1]
//   - enum/last metric aggregates via ARRAY_AGG(value_str...)
//   - Re-running is idempotent: computed_at updates but the row count stays the same.
//
// Gated by RUN_INTEGRATION=1.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

const CONNECTION_STRING =
  process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

const TAG_PRODUCT = '00000000-0000-4000-8000-00000000c001';
const TAG_PRODUCT_B = '00000000-0000-4000-8000-00000000c002';

let client: Client;

async function seed(client: Client): Promise<void> {
  // Two hourly buckets for TAG_PRODUCT and one for TAG_PRODUCT_B.
  const bucketA = '2026-07-13T10:00:00Z';
  const bucketB = '2026-07-13T11:00:00Z';

  // daily_active_users (int/sum) — 3 events in bucket A: [10, 10, 10] → 30
  await client.query(
    `INSERT INTO metric_events (product_id, metric_name, value_num, occurred_at)
     VALUES ($1, 'daily_active_users', 10, $2),
            ($1, 'daily_active_users', 10, $2),
            ($1, 'daily_active_users', 10, $2)`,
    [TAG_PRODUCT, bucketA],
  );

  // churn_rate (float/avg) — 3 events in bucket A: [0.02, 0.04, 0.06] → 0.04
  await client.query(
    `INSERT INTO metric_events (product_id, metric_name, value_num, occurred_at)
     VALUES ($1, 'churn_rate', 0.02, $2),
            ($1, 'churn_rate', 0.04, $2),
            ($1, 'churn_rate', 0.06, $2)`,
    [TAG_PRODUCT, bucketA],
  );

  // mrr_cents (int/last) — 2 events; the LATER one (bucketA + 30min) should win.
  await client.query(
    `INSERT INTO metric_events (product_id, metric_name, value_num, occurred_at)
     VALUES ($1, 'mrr_cents', 100000, $2),
            ($1, 'mrr_cents', 250000, $3)`,
    [TAG_PRODUCT, bucketA, '2026-07-13T10:30:00Z'],
  );

  // app_health_status (enum/last) — 2 events; the LATER one wins.
  await client.query(
    `INSERT INTO metric_events (product_id, metric_name, value_str, occurred_at)
     VALUES ($1, 'app_health_status', 'degraded', $2),
            ($1, 'app_health_status', 'ok', $3)`,
    [TAG_PRODUCT, bucketA, '2026-07-13T10:45:00Z'],
  );

  // Bucket B: single logins event for TAG_PRODUCT.
  await client.query(
    `INSERT INTO metric_events (product_id, metric_name, value_num, occurred_at)
     VALUES ($1, 'logins', 42, $2)`,
    [TAG_PRODUCT, bucketB],
  );

  // TAG_PRODUCT_B: separate row so we know per-product isolation works.
  await client.query(
    `INSERT INTO metric_events (product_id, metric_name, value_num, occurred_at)
     VALUES ($1, 'daily_active_users', 99, $2)`,
    [TAG_PRODUCT_B, bucketA],
  );
}

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
});

beforeEach(async () => {
  if (!RUN_INTEGRATION) return;
  await client.query(`DELETE FROM metric_events WHERE product_id IN ($1, $2)`, [
    TAG_PRODUCT,
    TAG_PRODUCT_B,
  ]);
  await client.query(`DELETE FROM metric_rollups WHERE product_id IN ($1, $2)`, [
    TAG_PRODUCT,
    TAG_PRODUCT_B,
  ]);
});

afterAll(async () => {
  if (!RUN_INTEGRATION) return;
  await client.query(`DELETE FROM metric_events WHERE product_id IN ($1, $2)`, [
    TAG_PRODUCT,
    TAG_PRODUCT_B,
  ]);
  await client.query(`DELETE FROM metric_rollups WHERE product_id IN ($1, $2)`, [
    TAG_PRODUCT,
    TAG_PRODUCT_B,
  ]);
  await client.end();
});

(RUN_INTEGRATION ? describe : describe.skip)('runRollup (hourly) against a real PG', () => {
  it('aggregates per catalog semantic and upserts into metric_rollups', async () => {
    await seed(client);
    const { runRollup } = await import('../rollupService.js');
    const now = new Date('2026-07-13T12:00:00Z');
    // Lookback of 4 hours so both bucketA (10:00) and bucketB (11:00) are included.
    await runRollup({ window: 'hourly', now, lookback: { unit: 'hours', count: 4 } });

    // daily_active_users: SUM = 30 in bucket A for TAG_PRODUCT
    const { rows: dauA } = await client.query<{ value_num: string }>(
      `SELECT value_num FROM metric_rollups
        WHERE product_id=$1 AND metric_name='daily_active_users'
          AND bucket_window='hourly' AND bucket_start=$2`,
      [TAG_PRODUCT, '2026-07-13T10:00:00Z'],
    );
    expect(dauA).toHaveLength(1);
    expect(Number(dauA[0]!.value_num)).toBe(30);

    // TAG_PRODUCT_B DAU: separate row = 99
    const { rows: dauB } = await client.query<{ value_num: string }>(
      `SELECT value_num FROM metric_rollups
        WHERE product_id=$1 AND metric_name='daily_active_users'
          AND bucket_window='hourly'`,
      [TAG_PRODUCT_B],
    );
    expect(dauB).toHaveLength(1);
    expect(Number(dauB[0]!.value_num)).toBe(99);

    // churn_rate: AVG = 0.04
    const { rows: churn } = await client.query<{ value_num: string }>(
      `SELECT value_num FROM metric_rollups
        WHERE product_id=$1 AND metric_name='churn_rate'
          AND bucket_window='hourly'`,
      [TAG_PRODUCT],
    );
    expect(churn).toHaveLength(1);
    expect(Number(churn[0]!.value_num)).toBeCloseTo(0.04, 4);

    // mrr_cents: LAST value = 250000 (occurred_at=10:30 > 10:00)
    const { rows: mrr } = await client.query<{ value_num: string }>(
      `SELECT value_num FROM metric_rollups
        WHERE product_id=$1 AND metric_name='mrr_cents'
          AND bucket_window='hourly'`,
      [TAG_PRODUCT],
    );
    expect(mrr).toHaveLength(1);
    expect(Number(mrr[0]!.value_num)).toBe(250000);

    // app_health_status: LAST value = 'ok' (occurred_at=10:45 > 10:00)
    const { rows: health } = await client.query<{ value_str: string }>(
      `SELECT value_str FROM metric_rollups
        WHERE product_id=$1 AND metric_name='app_health_status'
          AND bucket_window='hourly'`,
      [TAG_PRODUCT],
    );
    expect(health).toHaveLength(1);
    expect(health[0]!.value_str).toBe('ok');

    // logins: bucket B = 42
    const { rows: logins } = await client.query<{ value_num: string; bucket_start: Date }>(
      `SELECT value_num, bucket_start FROM metric_rollups
        WHERE product_id=$1 AND metric_name='logins'
          AND bucket_window='hourly'`,
      [TAG_PRODUCT],
    );
    expect(logins).toHaveLength(1);
    expect(Number(logins[0]!.value_num)).toBe(42);
  });

  it('re-running is idempotent (row count stable, computed_at advances)', async () => {
    await seed(client);
    const { runRollup } = await import('../rollupService.js');
    const now1 = new Date('2026-07-13T12:00:00Z');
    await runRollup({ window: 'hourly', now: now1, lookback: { unit: 'hours', count: 4 } });

    const { rows: firstCount } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM metric_rollups
        WHERE product_id IN ($1, $2)`,
      [TAG_PRODUCT, TAG_PRODUCT_B],
    );
    const initialRowCount = Number(firstCount[0]!.count);
    expect(initialRowCount).toBeGreaterThan(0);

    // Re-run with a later "now" — same buckets, but computed_at should update.
    const now2 = new Date('2026-07-13T12:30:00Z');
    await runRollup({ window: 'hourly', now: now2, lookback: { unit: 'hours', count: 4 } });

    const { rows: secondCount } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM metric_rollups
        WHERE product_id IN ($1, $2)`,
      [TAG_PRODUCT, TAG_PRODUCT_B],
    );
    expect(Number(secondCount[0]!.count)).toBe(initialRowCount);

    // computed_at should have advanced to now2 for at least one row.
    const { rows: computed } = await client.query<{ computed_at: Date }>(
      `SELECT computed_at FROM metric_rollups
        WHERE product_id=$1 AND metric_name='daily_active_users'
          AND bucket_window='hourly' LIMIT 1`,
      [TAG_PRODUCT],
    );
    expect(computed[0]!.computed_at.toISOString()).toBe(now2.toISOString());
  });
});
