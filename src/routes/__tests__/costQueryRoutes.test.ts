// Authorized by HUB-699 — unit tests: POST calculate, GET cost history, GET current-period, GET margin-summary; operator JWT
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCalculateCost = vi.hoisted(() => vi.fn());
const mockGetCurrentPeriodCost = vi.hoisted(() => vi.fn());
const mockGetPeriodCostHistory = vi.hoisted(() => vi.fn());
const mockGetMarginSummary = vi.hoisted(() => vi.fn());
vi.mock('../../services/costCalculationService.js', () => ({
  calculateCost: mockCalculateCost,
  getCurrentPeriodCost: mockGetCurrentPeriodCost,
  getPeriodCostHistory: mockGetPeriodCostHistory,
  getMarginSummary: mockGetMarginSummary,
}));

import costQueryRoutes from '../costQueryRoutes.js';

const TENANT_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const PRODUCT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

async function buildTestApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  (fastify as any).decorate('authenticateOperator', async (request: any) => {
    request.operator_id = 'test-operator-id';
  });
  await fastify.register(costQueryRoutes);
  await fastify.ready();
  return fastify;
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── POST /api/v1/pricing/calculate/:productId ─────────────────────────────────

describe('POST /api/v1/pricing/calculate/:productId', () => {
  it('returns 200 with cost_cents for valid request', async () => {
    mockCalculateCost.mockResolvedValueOnce({ cost_cents: 700 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/calculate/${PRODUCT_ID}`,
        payload: { unitCount: 70 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ cost_cents: 700 });
      expect(mockCalculateCost).toHaveBeenCalledWith(PRODUCT_ID, 70);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when unitCount is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/calculate/${PRODUCT_ID}`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when unitCount is not an integer', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/calculate/${PRODUCT_ID}`,
        payload: { unitCount: 3.5 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for non-UUID productId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/pricing/calculate/not-a-uuid',
        payload: { unitCount: 10 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 404 when calculateCost throws 404 (no active model)', async () => {
    mockCalculateCost.mockRejectedValueOnce(Object.assign(new Error('No active pricing model for product'), { statusCode: 404 }));
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/calculate/${PRODUCT_ID}`,
        payload: { unitCount: 10 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });

  it('returns breakdown for tiered model', async () => {
    mockCalculateCost.mockResolvedValueOnce({
      cost_cents: 1500,
      breakdown: [{ tier_order: 1, units: 100, unit_price_cents: 10, cost_cents: 1000 }, { tier_order: 2, units: 50, unit_price_cents: 10, cost_cents: 500 }],
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/calculate/${PRODUCT_ID}`,
        payload: { unitCount: 150 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ cost_cents: number; breakdown: unknown[] }>();
      expect(body.breakdown).toHaveLength(2);
    } finally {
      await fastify.close();
    }
  });
});

// ── GET /api/v1/costs/:tenantId ───────────────────────────────────────────────

describe('GET /api/v1/costs/:tenantId', () => {
  it('returns 200 with history rows', async () => {
    mockGetPeriodCostHistory.mockResolvedValueOnce([{ tenant_id: TENANT_ID, product_id: PRODUCT_ID }]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/${TENANT_ID}?productId=${PRODUCT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(mockGetPeriodCostHistory).toHaveBeenCalledWith(TENANT_ID, PRODUCT_ID, undefined, undefined);
    } finally {
      await fastify.close();
    }
  });

  it('returns 200 with empty array when no rows', async () => {
    mockGetPeriodCostHistory.mockResolvedValueOnce([]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/${TENANT_ID}?productId=${PRODUCT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when productId is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/${TENANT_ID}`,
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ message: string }>();
      expect(body.message).toContain('productId is required');
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/bad-id?productId=${PRODUCT_ID}`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('passes periodStart and periodEnd to service when provided', async () => {
    mockGetPeriodCostHistory.mockResolvedValueOnce([]);
    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/${TENANT_ID}?productId=${PRODUCT_ID}&periodStart=2026-01-01&periodEnd=2026-07-01`,
      });
      const call = mockGetPeriodCostHistory.mock.calls[0]!;
      expect(call[2]).toBeInstanceOf(Date);
      expect(call[3]).toBeInstanceOf(Date);
    } finally {
      await fastify.close();
    }
  });
});

// ── GET /api/v1/costs/:tenantId/current ──────────────────────────────────────

describe('GET /api/v1/costs/:tenantId/current', () => {
  it('returns 200 with current period cost from cost_ledger', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ current_period_start: new Date('2026-06-01T00:00:00Z') }],
    });
    mockGetCurrentPeriodCost.mockResolvedValueOnce({ total_cost_cents: 4500, unit_count: 90, event_count: 5 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/${TENANT_ID}/current?productId=${PRODUCT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total_cost_cents: 4500, unit_count: 90, event_count: 5 });
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when productId is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/${TENANT_ID}/current`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('uses current month start as fallback when no stripe subscription exists', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no subscription
    mockGetCurrentPeriodCost.mockResolvedValueOnce({ total_cost_cents: 0, unit_count: 0, event_count: 0 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/${TENANT_ID}/current?productId=${PRODUCT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      // Verify getCurrentPeriodCost was called with a Date
      const call = mockGetCurrentPeriodCost.mock.calls[0]!;
      expect(call[2]).toBeInstanceOf(Date);
    } finally {
      await fastify.close();
    }
  });

  it('queries stripe_subscriptions with tenant_id and product_id', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ current_period_start: new Date() }] });
    mockGetCurrentPeriodCost.mockResolvedValueOnce({ total_cost_cents: 0, unit_count: 0, event_count: 0 });
    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/costs/${TENANT_ID}/current?productId=${PRODUCT_ID}`,
      });
      const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
      expect(sql).toContain('stripe_subscriptions');
      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(params).toContain(TENANT_ID);
      expect(params).toContain(PRODUCT_ID);
    } finally {
      await fastify.close();
    }
  });
});

// ── GET /api/v1/pricing/margin-summary/:tenantId ─────────────────────────────

describe('GET /api/v1/pricing/margin-summary/:tenantId', () => {
  it('returns 200 with margin evaluation rows', async () => {
    const rows = [{ id: 'eval-1', margin_percentage: 42.5, below_floor: false }];
    mockGetMarginSummary.mockResolvedValueOnce(rows);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/margin-summary/${TENANT_ID}?productId=${PRODUCT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject(rows);
      expect(mockGetMarginSummary).toHaveBeenCalledWith(TENANT_ID, PRODUCT_ID);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when productId is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/margin-summary/${TENANT_ID}`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns empty array when no margin evaluations exist', async () => {
    mockGetMarginSummary.mockResolvedValueOnce([]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/margin-summary/${TENANT_ID}?productId=${PRODUCT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/margin-summary/bad-id?productId=${PRODUCT_ID}`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});
