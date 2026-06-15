// Authorized by HUB-671 — unit tests: aggregatePeriodCosts() and getPeriodCostSummary()
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockClientQuery = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease }),
);

vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ connect: mockConnect, query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { aggregatePeriodCosts, getPeriodCostSummary } from '../billingPeriodCostService.js';

const TENANT_ID = 'tenant-1';
const PRODUCT_ID = 'product-1';
const PERIOD_START = new Date('2026-06-01T00:00:00Z');
const PERIOD_END = new Date('2026-07-01T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockRelease.mockReturnValue(undefined);
});

function mockAggregateSequence({
  total_cost_cents = '5000',
  total_units = '10',
  event_count = '3',
  late_event_count = '1',
} = {}) {
  mockClientQuery
    .mockResolvedValueOnce({ rows: [{ total_cost_cents, total_units, event_count, late_event_count }] }) // SELECT aggregate
    .mockResolvedValueOnce({ rows: [] }); // UPSERT
}

// ── aggregatePeriodCosts ──────────────────────────────────────────────────────

describe('aggregatePeriodCosts()', () => {
  it('issues aggregate SELECT with occurred_at bounds (not ingested_at)', async () => {
    mockAggregateSequence();

    await aggregatePeriodCosts(TENANT_ID, PRODUCT_ID, PERIOD_START, PERIOD_END);

    const selectCall = mockClientQuery.mock.calls[0]!;
    const sql: string = selectCall[0] as string;
    expect(sql).toContain('occurred_at >= $3');
    expect(sql).toContain('occurred_at  < $4');
    expect(sql).not.toContain('ingested_at');
  });

  it('upserts aggregated totals into billing_period_costs', async () => {
    mockAggregateSequence({ total_cost_cents: '9000', total_units: '20', event_count: '5', late_event_count: '2' });

    await aggregatePeriodCosts(TENANT_ID, PRODUCT_ID, PERIOD_START, PERIOD_END);

    const upsertCall = mockClientQuery.mock.calls[1]!;
    const sql: string = upsertCall[0] as string;
    expect(sql).toContain('ON CONFLICT (tenant_id, product_id, period_start) DO UPDATE');
    const params = upsertCall[1] as unknown[];
    expect(params).toContain(9000);
    expect(params).toContain(20);
    expect(params).toContain(5);
    expect(params).toContain(2);
  });

  it('upserts zero-summary row when no cost_ledger rows exist in period', async () => {
    mockAggregateSequence({ total_cost_cents: '0', total_units: '0', event_count: '0', late_event_count: '0' });

    await aggregatePeriodCosts(TENANT_ID, PRODUCT_ID, PERIOD_START, PERIOD_END);

    const upsertCall = mockClientQuery.mock.calls[1]!;
    const params = upsertCall[1] as unknown[];
    expect(params).toContain(0); // total_cost_cents
  });

  it('releases the client connection in finally block even on error', async () => {
    mockClientQuery.mockRejectedValueOnce(new Error('DB error'));

    await expect(
      aggregatePeriodCosts(TENANT_ID, PRODUCT_ID, PERIOD_START, PERIOD_END),
    ).rejects.toThrow('DB error');

    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('is idempotent — two calls produce the same upsert params', async () => {
    mockAggregateSequence({ total_cost_cents: '4000', total_units: '8', event_count: '4', late_event_count: '0' });
    mockAggregateSequence({ total_cost_cents: '4000', total_units: '8', event_count: '4', late_event_count: '0' });

    await aggregatePeriodCosts(TENANT_ID, PRODUCT_ID, PERIOD_START, PERIOD_END);
    await aggregatePeriodCosts(TENANT_ID, PRODUCT_ID, PERIOD_START, PERIOD_END);

    // Both upsert calls use identical params (same aggregate result = same upsert)
    const firstUpsertParams = mockClientQuery.mock.calls[1]![1] as unknown[];
    const secondUpsertParams = mockClientQuery.mock.calls[3]![1] as unknown[];
    expect(firstUpsertParams).toEqual(secondUpsertParams);
  });

  it('includes late_event_count separately from event_count', async () => {
    mockAggregateSequence({ event_count: '5', late_event_count: '2' });

    await aggregatePeriodCosts(TENANT_ID, PRODUCT_ID, PERIOD_START, PERIOD_END);

    const upsertParams = mockClientQuery.mock.calls[1]![1] as unknown[];
    expect(upsertParams).toContain(5); // event_count
    expect(upsertParams).toContain(2); // late_event_count
  });
});

// ── getPeriodCostSummary ──────────────────────────────────────────────────────

describe('getPeriodCostSummary()', () => {
  it('returns the billing_period_costs row when it exists', async () => {
    const mockRow = {
      tenant_id: TENANT_ID,
      product_id: PRODUCT_ID,
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      total_units: 10,
      total_cost_cents: 5000,
      event_count: 3,
      late_event_count: 1,
      aggregated_at: new Date(),
    };
    mockPoolQuery.mockResolvedValueOnce({ rows: [mockRow] });

    const result = await getPeriodCostSummary(TENANT_ID, PRODUCT_ID, PERIOD_START);

    expect(result).toEqual(mockRow);
  });

  it('returns null when no summary exists for the period', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPeriodCostSummary(TENANT_ID, PRODUCT_ID, PERIOD_START);

    expect(result).toBeNull();
  });

  it('queries by (tenant_id, product_id, period_start)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await getPeriodCostSummary(TENANT_ID, PRODUCT_ID, PERIOD_START);

    const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
    expect(params).toEqual([TENANT_ID, PRODUCT_ID, PERIOD_START]);
  });
});
