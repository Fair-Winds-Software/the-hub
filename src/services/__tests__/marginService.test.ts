// Authorized by HUB-643 — unit tests: evaluateMargin(); margin calculation, D-001, below_floor publication
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockAlertsAdd = vi.hoisted(() => vi.fn());
vi.mock('../../queues/index.js', () => ({
  getAlertsQueue: () => ({ add: mockAlertsAdd }),
}));

import { evaluateMargin } from '../marginService.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockAlertsAdd.mockResolvedValue(undefined);
});

function mockQueries({
  revenue = '10000',
  cost = '3000',
  config = { floor_percentage: '30', enabled: true } as { floor_percentage: string; enabled: boolean } | null,
} = {}) {
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [{ revenue }] })      // revenue query
    .mockResolvedValueOnce({ rows: [{ cost }] })          // cost query
    .mockResolvedValueOnce({ rows: config ? [config] : [] }) // config query
    .mockResolvedValueOnce({ rows: [] });                  // INSERT margin_evaluations
}

// ── Margin calculation ────────────────────────────────────────────────────────

describe('evaluateMargin() — calculation', () => {
  it('calculates margin_percentage correctly: ((revenue - cost) / revenue) * 100', async () => {
    // (10000 - 3000) / 10000 * 100 = 70%
    mockQueries({ revenue: '10000', cost: '3000', config: null });

    const result = await evaluateMargin('tenant-1', 'product-1');

    expect(result.revenue_cents).toBe(10000);
    expect(result.cost_cents).toBe(3000);
    expect(result.margin_percentage).toBe(70);
  });

  it('returns margin_percentage = 0 when revenue is zero (no division by zero)', async () => {
    mockQueries({ revenue: '0', cost: '0', config: null });

    const result = await evaluateMargin('tenant-1', 'product-1');

    expect(result.margin_percentage).toBe(0);
    expect(result.below_floor).toBe(false);
  });

  it('inserts margin_evaluations row on every call', async () => {
    mockQueries({ revenue: '5000', cost: '1000', config: null });

    await evaluateMargin('tenant-1', 'product-1');

    const insertCall = mockPoolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO margin_evaluations'),
    );
    expect(insertCall).toBeDefined();
  });
});

// ── below_floor logic ─────────────────────────────────────────────────────────

describe('evaluateMargin() — below_floor', () => {
  it('publishes below_floor alert when margin < floor and enabled=true', async () => {
    // margin = 30%, floor = 40% → below floor
    mockQueries({ revenue: '10000', cost: '7000', config: { floor_percentage: '40', enabled: true } });

    const result = await evaluateMargin('tenant-1', 'product-1');

    expect(result.below_floor).toBe(true);
    expect(mockAlertsAdd).toHaveBeenCalledWith(
      'below_floor',
      expect.objectContaining({ tenantId: 'tenant-1', productId: 'product-1', margin_percentage: 30 }),
    );
  });

  it('does NOT publish alert when margin >= floor', async () => {
    // margin = 70%, floor = 40% → above floor
    mockQueries({ revenue: '10000', cost: '3000', config: { floor_percentage: '40', enabled: true } });

    const result = await evaluateMargin('tenant-1', 'product-1');

    expect(result.below_floor).toBe(false);
    expect(mockAlertsAdd).not.toHaveBeenCalled();
  });

  it('does NOT publish alert when enabled=false even if margin < floor', async () => {
    mockQueries({ revenue: '10000', cost: '8000', config: { floor_percentage: '40', enabled: false } });

    const result = await evaluateMargin('tenant-1', 'product-1');

    expect(result.below_floor).toBe(false);
    expect(mockAlertsAdd).not.toHaveBeenCalled();
  });

  it('does NOT publish alert when no margin_configs row exists', async () => {
    mockQueries({ revenue: '10000', cost: '9000', config: null });

    const result = await evaluateMargin('tenant-1', 'product-1');

    expect(result.below_floor).toBe(false);
    expect(mockAlertsAdd).not.toHaveBeenCalled();
  });

  it('records below_floor=true when revenue=0 and floor>0', async () => {
    mockQueries({ revenue: '0', cost: '0', config: { floor_percentage: '20', enabled: true } });

    const result = await evaluateMargin('tenant-1', 'product-1');

    // margin=0, floor=20 → below floor
    expect(result.below_floor).toBe(true);
    expect(mockAlertsAdd).toHaveBeenCalled();
  });
});

// ── D-001 invariant ───────────────────────────────────────────────────────────

describe('evaluateMargin() — D-001 invariant', () => {
  it('NEVER calls any state-modifying function (suspendLicense, freezeAccount, cancelSubscription)', async () => {
    // D-001: evaluateMargin must be purely read + audit + alert, zero blocking side effects.
    // Verify by ensuring the only "write" call is the INSERT into margin_evaluations and the BullMQ add.
    mockQueries({ revenue: '10000', cost: '9000', config: { floor_percentage: '40', enabled: true } });

    await evaluateMargin('tenant-1', 'product-1');

    const queryCalls = mockPoolQuery.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    const writeOps = queryCalls.filter((q) => q.includes('INSERT') || q.includes('UPDATE') || q.includes('DELETE'));

    // Only the margin_evaluations INSERT is permitted
    expect(writeOps).toHaveLength(1);
    expect(writeOps[0]).toContain('INSERT INTO margin_evaluations');
  });

  it('swallows BullMQ publish failure and still returns evaluation result', async () => {
    mockQueries({ revenue: '10000', cost: '9000', config: { floor_percentage: '40', enabled: true } });
    mockAlertsAdd.mockRejectedValueOnce(new Error('Queue down'));

    const result = await evaluateMargin('tenant-1', 'product-1');

    expect(result.below_floor).toBe(true);
    expect(result.margin_percentage).toBe(10);
  });
});
