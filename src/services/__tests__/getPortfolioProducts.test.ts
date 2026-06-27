// Authorized by HUB-1700 (E-BE-1 S23) — unit tests for getPortfolioProducts.
// Mocks pool to verify WHERE clause construction (operatorTenantId vs null), search
// ILIKE, limit cap, offset clamp, CTE shape, and result mapping.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

import { getPortfolioProducts } from '../portfolioService.js';

const PRODUCT = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  // getPortfolioProducts runs 2 queries: COUNT, then data fetch.
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [{ count: '0' }] })
    .mockResolvedValueOnce({ rows: [] });
});

describe('getPortfolioProducts (HUB-1700)', () => {
  it('null operatorTenantId (super_admin) → no tenant scope filter', async () => {
    await getPortfolioProducts({ operatorTenantId: null });
    const [countSql, countParams] = mockPoolQuery.mock.calls[0]!;
    expect(countSql).not.toMatch(/WHERE p\.tenant_id/);
    expect(countParams).toEqual([]);
  });

  it('operatorTenantId (product_admin) → WHERE p.tenant_id scope filter', async () => {
    await getPortfolioProducts({ operatorTenantId: TENANT });
    const [countSql, countParams] = mockPoolQuery.mock.calls[0]!;
    expect(countSql).toMatch(/WHERE p\.tenant_id = \$1/);
    expect(countParams).toEqual([TENANT]);
  });

  it('search → ILIKE pattern on p.name with %wrap%', async () => {
    await getPortfolioProducts({ search: 'foo' });
    const [, params] = mockPoolQuery.mock.calls[0]!;
    expect(mockPoolQuery.mock.calls[0]![0]).toMatch(/p\.name ILIKE/);
    expect(params).toContain('%foo%');
  });

  it('operatorTenantId + search → both clauses AND-joined', async () => {
    await getPortfolioProducts({ operatorTenantId: TENANT, search: 'foo' });
    const [sql] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/WHERE p\.tenant_id = \$1 AND p\.name ILIKE \$2/);
  });

  it('limit > 200 is capped at 200', async () => {
    await getPortfolioProducts({ limit: 500 });
    const [, params] = mockPoolQuery.mock.calls[1]!;
    expect(params[params.length - 2]).toBe(200);
  });

  it('negative offset is clamped to 0', async () => {
    await getPortfolioProducts({ offset: -10 });
    const [, params] = mockPoolQuery.mock.calls[1]!;
    expect(params[params.length - 1]).toBe(0);
  });

  it('default limit is 100 when omitted', async () => {
    await getPortfolioProducts({});
    const [, params] = mockPoolQuery.mock.calls[1]!;
    expect(params[params.length - 2]).toBe(100);
  });

  it('data query uses CTEs (latest_billing + product_mrr + product_last_active) and ORDER BY p.name ASC', async () => {
    await getPortfolioProducts({});
    const [rowSql] = mockPoolQuery.mock.calls[1]!;
    expect(rowSql).toMatch(/WITH latest_billing AS/);
    expect(rowSql).toMatch(/product_mrr AS/);
    expect(rowSql).toMatch(/product_last_active AS/);
    expect(rowSql).toMatch(/ORDER BY p\.name ASC/);
  });

  it('result mapping: full shape with ISO dates + parsed mrr_cents bigint', async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: PRODUCT,
            product_name: 'Alpha',
            tenant_id: TENANT,
            tenant_name: 'Acme',
            status: 'active',
            mrr_cents: '12345',
            created_at: new Date('2026-01-15T00:00:00Z'),
            last_active_at: new Date('2026-06-01T00:00:00Z'),
          },
        ],
      });

    const result = await getPortfolioProducts({});
    expect(result.total).toBe(1);
    expect(result.data[0]).toEqual({
      productId: PRODUCT,
      productName: 'Alpha',
      tenantId: TENANT,
      tenantName: 'Acme',
      status: 'active',
      mrrCents: 12345,
      createdAt: '2026-01-15T00:00:00.000Z',
      lastActiveAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('lastActiveAt is null when no subscription exists for the product', async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: PRODUCT,
            product_name: 'Quiet',
            tenant_id: TENANT,
            tenant_name: 'Acme',
            status: 'active',
            mrr_cents: '0',
            created_at: new Date('2026-01-15T00:00:00Z'),
            last_active_at: null,
          },
        ],
      });

    const result = await getPortfolioProducts({});
    expect(result.data[0]!.lastActiveAt).toBeNull();
    expect(result.data[0]!.mrrCents).toBe(0);
  });

  it('handles null mrr_cents from pool (no billing data) as 0', async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: PRODUCT,
            product_name: 'NewProd',
            tenant_id: TENANT,
            tenant_name: 'Acme',
            status: 'active',
            mrr_cents: null,
            created_at: new Date('2026-06-15T00:00:00Z'),
            last_active_at: null,
          },
        ],
      });

    const result = await getPortfolioProducts({});
    expect(result.data[0]!.mrrCents).toBe(0);
  });
});
