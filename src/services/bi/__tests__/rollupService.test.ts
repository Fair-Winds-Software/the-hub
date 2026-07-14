// Authorized by HUB-1806 (S4 of HUB-1785) — unit tests for runRollup(). Pool is mocked;
// tests inspect the SQL text and parameter tuple to verify:
//   1. one INSERT ... ON CONFLICT per catalog metric per invocation
//   2. correct DATE_TRUNC unit per window (hourly/daily/monthly)
//   3. correct aggregate expression per rollup semantic (sum/avg/max/last)
//   4. enum metrics use value_str column + ARRAY_AGG(...ORDER BY occurred_at DESC)[1]
//   5. correct lookback interval per window (defaults + override)
//   6. return shape reports rows_upserted + metrics_processed + duration_ms
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listCatalog } from '../metricCatalog.js';

const mockPool = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rowCount: 3, rows: [] })),
}));
vi.mock('../../../db/pool.js', () => ({ getPool: () => mockPool }));

const { runRollup } = await import('../rollupService.js');

const NOW = new Date('2026-07-13T12:00:00Z');
const TOTAL_METRICS = listCatalog().length;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runRollup — invocation shape', () => {
  it('fires one INSERT per catalog metric', async () => {
    const result = await runRollup({ window: 'hourly', now: NOW });
    expect(mockPool.query).toHaveBeenCalledTimes(TOTAL_METRICS);
    expect(result.metrics_processed).toBe(TOTAL_METRICS);
    expect(result.window).toBe('hourly');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('aggregates rows_upserted across all metrics', async () => {
    mockPool.query.mockResolvedValue({ rowCount: 5, rows: [] });
    const result = await runRollup({ window: 'daily', now: NOW });
    expect(result.rows_upserted).toBe(5 * TOTAL_METRICS);
  });
});

describe('runRollup — SQL shape per window', () => {
  it("hourly uses DATE_TRUNC unit 'hour' and default 2h lookback interval", async () => {
    await runRollup({ window: 'hourly', now: NOW });
    const firstCall = mockPool.query.mock.calls[0]!;
    const params = firstCall[1] as unknown[];
    expect(params[0]).toBe('hourly'); // window
    expect(params[1]).toBe('hour'); // DATE_TRUNC arg
    expect(params[2]).toEqual(NOW); // computed_at
    expect(params[4]).toBe('2 hours'); // lookback interval
  });

  it("daily uses DATE_TRUNC unit 'day' and default 2d lookback interval", async () => {
    await runRollup({ window: 'daily', now: NOW });
    const firstCall = mockPool.query.mock.calls[0]!;
    const params = firstCall[1] as unknown[];
    expect(params[0]).toBe('daily');
    expect(params[1]).toBe('day');
    expect(params[4]).toBe('2 days');
  });

  it("monthly uses DATE_TRUNC unit 'month' and default 2mo lookback interval", async () => {
    await runRollup({ window: 'monthly', now: NOW });
    const firstCall = mockPool.query.mock.calls[0]!;
    const params = firstCall[1] as unknown[];
    expect(params[0]).toBe('monthly');
    expect(params[1]).toBe('month');
    expect(params[4]).toBe('2 months');
  });

  it('honors an explicit lookback override', async () => {
    await runRollup({
      window: 'hourly',
      now: NOW,
      lookback: { unit: 'hours', count: 24 },
    });
    const firstCall = mockPool.query.mock.calls[0]!;
    const params = firstCall[1] as unknown[];
    expect(params[4]).toBe('24 hours');
  });
});

describe('runRollup — aggregate expression per catalog semantic', () => {
  it("emits SUM(value_num) for the 'daily_active_users' metric (sum semantic)", async () => {
    await runRollup({ window: 'daily', now: NOW });
    const dauCall = mockPool.query.mock.calls.find(
      (c) => (c[1] as unknown[])[3] === 'daily_active_users',
    );
    expect(dauCall).toBeDefined();
    expect(dauCall![0]).toContain('SUM(value_num)');
    expect(dauCall![0]).toContain('value_num');
    expect(dauCall![0]).not.toContain('value_str');
  });

  it("emits AVG(value_num) for 'churn_rate' (avg semantic)", async () => {
    await runRollup({ window: 'daily', now: NOW });
    const churnCall = mockPool.query.mock.calls.find(
      (c) => (c[1] as unknown[])[3] === 'churn_rate',
    );
    expect(churnCall).toBeDefined();
    expect(churnCall![0]).toContain('AVG(value_num)');
  });

  it("emits ARRAY_AGG(value_num ORDER BY occurred_at DESC, ingested_at DESC)[1] for 'mrr_cents' (last semantic)", async () => {
    await runRollup({ window: 'daily', now: NOW });
    const mrrCall = mockPool.query.mock.calls.find(
      (c) => (c[1] as unknown[])[3] === 'mrr_cents',
    );
    expect(mrrCall).toBeDefined();
    expect(mrrCall![0]).toContain('ARRAY_AGG(value_num ORDER BY occurred_at DESC');
  });

  it("uses value_str column + ARRAY_AGG(value_str ...) for enum metric 'app_health_status'", async () => {
    await runRollup({ window: 'hourly', now: NOW });
    const healthCall = mockPool.query.mock.calls.find(
      (c) => (c[1] as unknown[])[3] === 'app_health_status',
    );
    expect(healthCall).toBeDefined();
    const sql = healthCall![0] as string;
    expect(sql).toContain('value_str');
    expect(sql).toContain('ARRAY_AGG(value_str ORDER BY occurred_at DESC');
    // The INSERT column list must include value_str and not value_num.
    expect(sql).toContain('bucket_start,\n         value_str, sample_count');
  });
});

describe('runRollup — ON CONFLICT idempotency clause', () => {
  it('every query includes the ON CONFLICT DO UPDATE upsert path', async () => {
    await runRollup({ window: 'hourly', now: NOW });
    for (const call of mockPool.query.mock.calls) {
      const sql = call[0] as string;
      expect(sql).toContain(
        'ON CONFLICT (product_id, metric_name, dimensions, bucket_window, bucket_start)',
      );
      expect(sql).toContain('DO UPDATE SET');
      expect(sql).toContain('computed_at    = EXCLUDED.computed_at');
    }
  });
});
