// Authorized by HUB-1699 (E-BE-1 S22) — unit tests for listRecommendations.
// Mocks pool to verify WHERE clause construction, ANY() filtering for multi-outcome,
// limit cap, LEFT JOIN LATERAL latest-outcome shape, and {data, total} response.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// pricingModelService is imported by planAdvisorService; stub the dependency to a no-op.
vi.mock('../pricingModelService.js', () => ({
  getActivePricingModel: vi.fn(),
}));

import { listRecommendations } from '../planAdvisorService.js';

const PRODUCT = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';
const REC_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  // listRecommendations runs 2 queries: COUNT, then data fetch.
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    .mockResolvedValueOnce({ rows: [] });
});

describe('listRecommendations (HUB-1699)', () => {
  it('no filter → no WHERE clause, ORDER BY created_at DESC, default limit 50', async () => {
    const result = await listRecommendations({});

    const [countSql, countParams] = mockPoolQuery.mock.calls[0]!;
    // No top-level filter clauses (the LEFT JOIN LATERAL subquery has its own WHERE).
    expect(countSql).not.toMatch(/WHERE ar\.product_id/);
    expect(countSql).not.toMatch(/WHERE latest_outcome/);
    expect(countParams).toEqual([]);

    const [rowSql, rowParams] = mockPoolQuery.mock.calls[1]!;
    expect(rowSql).toMatch(/ORDER BY ar\.created_at DESC/);
    expect(rowSql).toMatch(/LEFT JOIN LATERAL/);
    // Last two params are limit, offset
    expect(rowParams[rowParams.length - 2]).toBe(50);
    expect(rowParams[rowParams.length - 1]).toBe(0);
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('productId filter → WHERE ar.product_id = $1', async () => {
    await listRecommendations({ productId: PRODUCT });
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/WHERE ar\.product_id = \$1/);
    expect(params).toEqual([PRODUCT]);
  });

  it('outcome filter single → ANY(::text[]) with single-element array', async () => {
    await listRecommendations({ outcomes: ['won'] });
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/latest_outcome\.outcome_type = ANY\(\$\d+::text\[\]\)/);
    expect(params).toContainEqual(['won']);
  });

  it('outcome filter multi → ANY(::text[]) with the full array', async () => {
    await listRecommendations({ outcomes: ['won', 'lost', 'applied'] });
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/latest_outcome\.outcome_type = ANY/);
    expect(params).toContainEqual(['won', 'lost', 'applied']);
  });

  it('productId + outcome combined → both clauses AND-joined', async () => {
    await listRecommendations({ productId: PRODUCT, outcomes: ['won'] });
    const [sql] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/WHERE ar\.product_id = \$1 AND latest_outcome\.outcome_type/);
  });

  it('limit > 200 is capped at 200', async () => {
    await listRecommendations({ limit: 500 });
    const [, params] = mockPoolQuery.mock.calls[1]!;
    expect(params[params.length - 2]).toBe(200);
  });

  it('offset is clamped to >= 0', async () => {
    await listRecommendations({ offset: -10 });
    const [, params] = mockPoolQuery.mock.calls[1]!;
    expect(params[params.length - 1]).toBe(0);
  });

  it('result mapping: returns expected list shape with schema-deviation nulls', async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            recommendation_id: REC_ID,
            product_id: PRODUCT,
            tenant_id: TENANT,
            product_name: 'Alpha',
            recommended_plan: 'tiered',
            reasoning: 'Upgrade likely; usage trending up',
            mrr_impact: 4900,
            outcome: 'won',
            outcome_note: 'closed in Q3',
            created_at: new Date('2026-06-01T00:00:00Z'),
            outcome_captured_at: new Date('2026-06-15T00:00:00Z'),
          },
        ],
      });

    const result = await listRecommendations({});
    expect(result.total).toBe(1);
    expect(result.data[0]).toEqual({
      recommendationId: REC_ID,
      productId: PRODUCT,
      tenantId: TENANT,
      productName: 'Alpha',
      currentPlan: null, // documented deviation: not in schema
      recommendedPlan: 'tiered',
      reasoning: 'Upgrade likely; usage trending up',
      mrrImpact: 4900,
      churnRisk: null, // documented deviation: not in schema
      outcome: 'won',
      outcomeNote: 'closed in Q3',
      createdAt: '2026-06-01T00:00:00.000Z',
      outcomeCapturedAt: '2026-06-15T00:00:00.000Z',
      operatorEmail: null, // documented deviation: not in schema
    });
  });

  it('outcome null when recommendation has no advisor_outcome row (LEFT JOIN)', async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            recommendation_id: REC_ID,
            product_id: PRODUCT,
            tenant_id: TENANT,
            product_name: 'Alpha',
            recommended_plan: null,
            reasoning: 'r',
            mrr_impact: null,
            outcome: null,
            outcome_note: null,
            created_at: new Date('2026-06-01T00:00:00Z'),
            outcome_captured_at: null,
          },
        ],
      });

    const result = await listRecommendations({});
    expect(result.data[0]!.outcome).toBeNull();
    expect(result.data[0]!.outcomeCapturedAt).toBeNull();
  });
});
