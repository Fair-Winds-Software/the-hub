// Authorized by HUB-685 — unit tests: calculateCost() all model types, edge cases; query helper SQL delegation
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetActivePricingModel = vi.hoisted(() => vi.fn());
vi.mock('../../services/pricingModelService.js', () => ({
  getActivePricingModel: mockGetActivePricingModel,
}));

import {
  calculateCost,
  getCurrentPeriodCost,
  getPeriodCostHistory,
  getMarginSummary,
} from '../costCalculationService.js';

const PRODUCT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeFlatRateModel() {
  return {
    model_id: 'model-1',
    product_id: PRODUCT_ID,
    model_type: 'flat_rate',
    currency: 'USD',
    config: { price_cents: 5000 },
    active: true,
    activated_at: null,
    deprecated_at: null,
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tiers: [],
  };
}

function makeUsageBasedModel() {
  return {
    ...makeFlatRateModel(),
    model_type: 'usage_based',
    config: { unit_price_cents: 10 },
  };
}

function makePerSeatModel() {
  return {
    ...makeFlatRateModel(),
    model_type: 'per_seat',
    config: { seat_price_cents: 2000 },
  };
}

function makeTieredModel() {
  return {
    ...makeFlatRateModel(),
    model_type: 'tiered',
    config: {},
    tiers: [
      { tier_id: 't1', model_id: 'model-1', tier_order: 1, up_to_units: 100, unit_price_cents: 10, flat_fee_cents: 0 },
      { tier_id: 't2', model_id: 'model-1', tier_order: 2, up_to_units: 500, unit_price_cents: 8,  flat_fee_cents: 0 },
      { tier_id: 't3', model_id: 'model-1', tier_order: 3, up_to_units: null, unit_price_cents: 5, flat_fee_cents: 0 },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ── calculateCost — validation ────────────────────────────────────────────────

describe('calculateCost() — validation', () => {
  it('throws 400 for negative unitCount', async () => {
    await expect(calculateCost(PRODUCT_ID, -1)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 for invalid productId UUID', async () => {
    await expect(calculateCost('not-a-uuid', 10)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 404 when no active pricing model', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(null);
    await expect(calculateCost(PRODUCT_ID, 5)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 400 for unknown model_type', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce({
      ...makeFlatRateModel(),
      model_type: 'mystery_model',
    });
    await expect(calculateCost(PRODUCT_ID, 10)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Unknown pricing model type'),
    });
  });
});

// ── calculateCost — unitCount=0 shortcut ──────────────────────────────────────

describe('calculateCost() — unitCount=0', () => {
  it('returns {cost_cents: 0} for flat_rate when unitCount=0', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeFlatRateModel());
    const result = await calculateCost(PRODUCT_ID, 0);
    expect(result).toEqual({ cost_cents: 0 });
  });

  it('returns {cost_cents: 0} for usage_based when unitCount=0', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeUsageBasedModel());
    const result = await calculateCost(PRODUCT_ID, 0);
    expect(result).toEqual({ cost_cents: 0 });
  });
});

// ── calculateCost — model types ───────────────────────────────────────────────

describe('calculateCost() — flat_rate', () => {
  it('returns fixed config.price_cents regardless of unitCount', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeFlatRateModel());
    const result = await calculateCost(PRODUCT_ID, 50);
    expect(result).toEqual({ cost_cents: 5000 });
  });

  it('has no breakdown for flat_rate', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeFlatRateModel());
    const result = await calculateCost(PRODUCT_ID, 1);
    expect(result.breakdown).toBeUndefined();
  });
});

describe('calculateCost() — usage_based', () => {
  it('returns unitCount * unit_price_cents', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeUsageBasedModel());
    const result = await calculateCost(PRODUCT_ID, 7);
    expect(result).toEqual({ cost_cents: 70 });
  });

  it('has no breakdown for usage_based', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeUsageBasedModel());
    const result = await calculateCost(PRODUCT_ID, 3);
    expect(result.breakdown).toBeUndefined();
  });
});

describe('calculateCost() — per_seat', () => {
  it('returns unitCount * seat_price_cents', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makePerSeatModel());
    const result = await calculateCost(PRODUCT_ID, 3);
    expect(result).toEqual({ cost_cents: 6000 });
  });
});

describe('calculateCost() — tiered (progressive bands)', () => {
  it('applies first tier only when unitCount fits in tier 1', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeTieredModel());
    // 50 units at $0.10 each = 500 cents
    const result = await calculateCost(PRODUCT_ID, 50);
    expect(result.cost_cents).toBe(500);
    expect(result.breakdown).toEqual([
      { tier_order: 1, units: 50, unit_price_cents: 10, cost_cents: 500 },
    ]);
  });

  it('spans tier 1 and tier 2 for unitCount=250', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeTieredModel());
    // 100 units at $0.10 = 1000 + 150 units at $0.08 = 1200 → total 2200
    const result = await calculateCost(PRODUCT_ID, 250);
    expect(result.cost_cents).toBe(2200);
    expect(result.breakdown).toHaveLength(2);
    expect(result.breakdown![0]).toEqual({ tier_order: 1, units: 100, unit_price_cents: 10, cost_cents: 1000 });
    expect(result.breakdown![1]).toEqual({ tier_order: 2, units: 150, unit_price_cents: 8,  cost_cents: 1200 });
  });

  it('spans all three tiers for unitCount=600', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeTieredModel());
    // tier1: 100 @ 10 = 1000, tier2: 400 @ 8 = 3200, tier3: 100 @ 5 = 500 → total 4700
    const result = await calculateCost(PRODUCT_ID, 600);
    expect(result.cost_cents).toBe(4700);
    expect(result.breakdown).toHaveLength(3);
  });

  it('handles unitCount exactly at tier boundary', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeTieredModel());
    // exactly 100 → only tier 1
    const result = await calculateCost(PRODUCT_ID, 100);
    expect(result.cost_cents).toBe(1000);
    expect(result.breakdown).toHaveLength(1);
  });

  it('handles unitCount=1 beyond last tier up_to_units boundary', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(makeTieredModel());
    // 501 units: tier1=100@10 + tier2=400@8 + tier3=1@5 = 1000+3200+5 = 4205
    const result = await calculateCost(PRODUCT_ID, 501);
    expect(result.cost_cents).toBe(4205);
    expect(result.breakdown).toHaveLength(3);
    expect(result.breakdown![2]!.units).toBe(1);
  });
});

// ── getCurrentPeriodCost ──────────────────────────────────────────────────────

describe('getCurrentPeriodCost()', () => {
  it('returns parsed integers from cost_ledger aggregate', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ total_cost_cents: '3000', unit_count: '15', event_count: '4' }],
    });
    const periodStart = new Date('2026-06-01T00:00:00Z');
    const result = await getCurrentPeriodCost(TENANT_ID, PRODUCT_ID, periodStart);
    expect(result).toEqual({ total_cost_cents: 3000, unit_count: 15, event_count: 4 });
  });

  it('passes occurred_at >= $3 with periodStart', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ total_cost_cents: '0', unit_count: '0', event_count: '0' }],
    });
    const periodStart = new Date('2026-06-01T00:00:00Z');
    await getCurrentPeriodCost(TENANT_ID, PRODUCT_ID, periodStart);
    const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('occurred_at >= $3');
  });

  it('throws 400 for invalid tenantId UUID', async () => {
    await expect(getCurrentPeriodCost('bad', PRODUCT_ID, new Date())).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── getPeriodCostHistory ──────────────────────────────────────────────────────

describe('getPeriodCostHistory()', () => {
  it('queries without date filters when both are omitted', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await getPeriodCostHistory(TENANT_ID, PRODUCT_ID);
    const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('ORDER BY period_start DESC');
    expect(sql).not.toContain('period_start >=');
  });

  it('adds periodStart filter when provided', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await getPeriodCostHistory(TENANT_ID, PRODUCT_ID, new Date('2026-01-01'));
    const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('period_start >=');
  });

  it('adds periodEnd filter when provided', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await getPeriodCostHistory(TENANT_ID, PRODUCT_ID, undefined, new Date('2026-07-01'));
    const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('period_end <=');
  });

  it('returns rows from billing_period_costs', async () => {
    const mockRow = {
      tenant_id: TENANT_ID,
      product_id: PRODUCT_ID,
      period_start: new Date('2026-06-01'),
      period_end: new Date('2026-07-01'),
      total_units: 10,
      total_cost_cents: 5000,
      event_count: 3,
      late_event_count: 1,
      aggregated_at: new Date(),
    };
    mockPoolQuery.mockResolvedValueOnce({ rows: [mockRow] });
    const result = await getPeriodCostHistory(TENANT_ID, PRODUCT_ID);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(mockRow);
  });
});

// ── getMarginSummary ──────────────────────────────────────────────────────────

describe('getMarginSummary()', () => {
  it('queries margin_evaluations ORDER BY evaluated_at DESC LIMIT 5', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await getMarginSummary(TENANT_ID, PRODUCT_ID);
    const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('margin_evaluations');
    expect(sql).toContain('ORDER BY evaluated_at DESC');
    expect(sql).toContain('LIMIT 5');
  });

  it('returns empty array when no evaluations exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getMarginSummary(TENANT_ID, PRODUCT_ID);
    expect(result).toEqual([]);
  });

  it('returns up to 5 rows', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `eval-${i}`,
      tenant_id: TENANT_ID,
      product_id: PRODUCT_ID,
      evaluated_at: new Date(),
      revenue_cents: 10000,
      cost_cents: 5000,
      margin_percentage: 50,
      below_floor: false,
    }));
    mockPoolQuery.mockResolvedValueOnce({ rows });
    const result = await getMarginSummary(TENANT_ID, PRODUCT_ID);
    expect(result).toHaveLength(5);
  });
});
