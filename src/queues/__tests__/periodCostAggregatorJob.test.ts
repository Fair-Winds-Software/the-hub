// Authorized by HUB-672 — unit tests: runPeriodCostAggregator(); period boundary, pair iteration, failure isolation
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockAggregatePeriodCosts = vi.hoisted(() => vi.fn());
vi.mock('../../services/billingPeriodCostService.js', () => ({
  aggregatePeriodCosts: mockAggregatePeriodCosts,
}));

import { runPeriodCostAggregator } from '../periodCostAggregatorJob.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockAggregatePeriodCosts.mockResolvedValue(undefined);
});

// ── Period boundary calculation ───────────────────────────────────────────────

describe('runPeriodCostAggregator() — period boundaries', () => {
  it('computes period_start as first day of current UTC month', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ tenant_id: 't1', product_id: 'p1' }] });

    await runPeriodCostAggregator();

    const [[, , periodStart]] = mockAggregatePeriodCosts.mock.calls;
    const ps = periodStart as Date;
    expect(ps.getUTCDate()).toBe(1);
    expect(ps.getUTCHours()).toBe(0);
    expect(ps.getUTCMinutes()).toBe(0);
    expect(ps.getUTCSeconds()).toBe(0);
  });

  it('computes period_end as first day of next UTC month', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ tenant_id: 't1', product_id: 'p1' }] });

    await runPeriodCostAggregator();

    const [[, , periodStart, periodEnd]] = mockAggregatePeriodCosts.mock.calls;
    const ps = periodStart as Date;
    const pe = periodEnd as Date;
    // period_end should be exactly one month after period_start
    expect(pe.getUTCMonth()).toBe((ps.getUTCMonth() + 1) % 12);
    expect(pe.getUTCDate()).toBe(1);
    expect(pe.getUTCHours()).toBe(0);
  });

  it('passes identical period_start and period_end to all pairs', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 't1', product_id: 'p1' },
        { tenant_id: 't2', product_id: 'p2' },
      ],
    });

    await runPeriodCostAggregator();

    const [[, , ps1, pe1], [, , ps2, pe2]] = mockAggregatePeriodCosts.mock.calls as [unknown, unknown, Date, Date][];
    expect(ps1).toEqual(ps2);
    expect(pe1).toEqual(pe2);
  });
});

// ── Pair iteration ────────────────────────────────────────────────────────────

describe('runPeriodCostAggregator() — pair iteration', () => {
  it('calls aggregatePeriodCosts for every active product', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 'tenant-1', product_id: 'product-1' },
        { tenant_id: 'tenant-2', product_id: 'product-2' },
        { tenant_id: 'tenant-3', product_id: 'product-3' },
      ],
    });

    await runPeriodCostAggregator();

    expect(mockAggregatePeriodCosts).toHaveBeenCalledTimes(3);
  });

  it('does nothing when no active products exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runPeriodCostAggregator();

    expect(mockAggregatePeriodCosts).not.toHaveBeenCalled();
  });

  it('queries only active products (WHERE status = active)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await runPeriodCostAggregator();

    const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain("status = 'active'");
  });
});

// ── Failure isolation ─────────────────────────────────────────────────────────

describe('runPeriodCostAggregator() — failure isolation', () => {
  it('continues processing remaining pairs when one pair fails', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 'tenant-1', product_id: 'product-1' },
        { tenant_id: 'tenant-2', product_id: 'product-2' },
        { tenant_id: 'tenant-3', product_id: 'product-3' },
      ],
    });

    mockAggregatePeriodCosts
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Pair 2 failed'))
      .mockResolvedValueOnce(undefined);

    await runPeriodCostAggregator();

    expect(mockAggregatePeriodCosts).toHaveBeenCalledTimes(3);
  });

  it('does not throw when all pairs fail', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { tenant_id: 'tenant-1', product_id: 'product-1' },
        { tenant_id: 'tenant-2', product_id: 'product-2' },
      ],
    });

    mockAggregatePeriodCosts.mockRejectedValue(new Error('All broken'));

    await expect(runPeriodCostAggregator()).resolves.not.toThrow();
  });
});
