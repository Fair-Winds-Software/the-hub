// Authorized by HUB-1804 (S2 of HUB-1785) — integration tests for the BI persistence
// migration (082). Verifies both tables exist with expected columns + the value XOR
// constraint fires + the unique upsert index rejects duplicates + the delta_data
// trigger populates on UPDATE.
//
// Gated by RUN_INTEGRATION=1 — needs a live PG. Skipped in fast CI.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const CONNECTION_STRING =
  process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

const TAG = `hub1804_${Date.now()}`;

let client: Client;

beforeAll(async () => {
  if (!RUN_INTEGRATION) return;
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  await client.query(`DELETE FROM metric_events WHERE metric_name LIKE $1`, [`${TAG}_%`]);
  await client.query(`DELETE FROM metric_rollups WHERE metric_name LIKE $1`, [`${TAG}_%`]);
});

afterAll(async () => {
  if (!RUN_INTEGRATION) return;
  await client.query(`DELETE FROM metric_events WHERE metric_name LIKE $1`, [`${TAG}_%`]);
  await client.query(`DELETE FROM metric_rollups WHERE metric_name LIKE $1`, [`${TAG}_%`]);
  await client.end();
});

(RUN_INTEGRATION ? describe : describe.skip)('metric_events schema', () => {
  it('table exists with all required columns', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='metric_events'`,
    );
    const cols = new Set(rows.map((r) => r.column_name));
    for (const c of [
      'id',
      'product_id',
      'metric_name',
      'dimensions',
      'value_num',
      'value_str',
      'occurred_at',
      'ingested_at',
      'delta_data',
    ]) {
      expect(cols.has(c)).toBe(true);
    }
  });

  it('value XOR constraint rejects rows with both value_num AND value_str', async () => {
    const err = await client
      .query(
        `INSERT INTO metric_events (product_id, metric_name, value_num, value_str, occurred_at)
           VALUES ($1, $2, 1, 'bad', NOW())`,
        ['00000000-0000-4000-8000-000000000001', `${TAG}_xor`],
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('23514');
  });

  it('value XOR constraint rejects rows with neither value', async () => {
    const err = await client
      .query(
        `INSERT INTO metric_events (product_id, metric_name, occurred_at)
           VALUES ($1, $2, NOW())`,
        ['00000000-0000-4000-8000-000000000001', `${TAG}_neither`],
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('23514');
  });

  it('delta trigger populates delta_data on UPDATE', async () => {
    const productId = '00000000-0000-4000-8000-000000000001';
    const metricName = `${TAG}_delta`;
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO metric_events (product_id, metric_name, value_num, occurred_at)
         VALUES ($1, $2, 1, NOW()) RETURNING id`,
      [productId, metricName],
    );
    await client.query(`UPDATE metric_events SET value_num = 2 WHERE id = $1`, [inserted[0]!.id]);
    const { rows: after } = await client.query<{ delta_data: unknown }>(
      `SELECT delta_data FROM metric_events WHERE id = $1`,
      [inserted[0]!.id],
    );
    expect(after[0]!.delta_data).not.toBeNull();
  });
});

(RUN_INTEGRATION ? describe : describe.skip)('metric_rollups schema', () => {
  it('unique upsert index rejects duplicates on the natural key', async () => {
    const productId = '00000000-0000-4000-8000-000000000002';
    const metricName = `${TAG}_uniq`;
    const bucket = new Date('2026-07-13T00:00:00Z');
    await client.query(
      `INSERT INTO metric_rollups
         (product_id, metric_name, dimensions, bucket_window, bucket_start, value_num, sample_count)
       VALUES ($1, $2, '{}'::jsonb, 'hourly', $3, 10, 5)`,
      [productId, metricName, bucket],
    );
    const err = await client
      .query(
        `INSERT INTO metric_rollups
           (product_id, metric_name, dimensions, bucket_window, bucket_start, value_num, sample_count)
         VALUES ($1, $2, '{}'::jsonb, 'hourly', $3, 20, 5)`,
        [productId, metricName, bucket],
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('23505');
  });

  it("window CHECK constraint rejects windows outside 'hourly'|'daily'|'monthly'", async () => {
    const err = await client
      .query(
        `INSERT INTO metric_rollups
           (product_id, metric_name, dimensions, bucket_window, bucket_start, value_num, sample_count)
         VALUES ($1, $2, '{}'::jsonb, 'yearly', NOW(), 1, 1)`,
        ['00000000-0000-4000-8000-000000000003', `${TAG}_win`],
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('23514');
  });
});
