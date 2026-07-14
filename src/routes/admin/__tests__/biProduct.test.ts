// Authorized by HUB-1808 (S6 of HUB-1785) — route tests for the per-product BI endpoints.
// The trend/health service and the products-scope lookup are both mocked so tests exercise
// the route wiring + RBAC scoping + validation without touching PG.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetTrendSeries = vi.hoisted(() =>
  vi.fn(async () => ({
    product_id: 'p-a',
    metric: 'daily_active_users',
    window: 'daily',
    range: '30d',
    series: [
      { bucket_start: '2026-07-01T00:00:00Z', value: 100, sample_count: 3 },
      { bucket_start: '2026-07-02T00:00:00Z', value: 120, sample_count: 3 },
    ],
  })),
);
const mockGetProductHealth = vi.hoisted(() =>
  vi.fn(async () => ({
    product_id: 'p-a',
    health: 'ok' as const,
    as_of: '2026-07-13T11:00:00Z',
    reason: null,
  })),
);
const mockPoolQuery = vi.hoisted(() => vi.fn(async () => ({ rows: [] as unknown[] })));

vi.mock('../../../services/bi/productTrendService.js', () => ({
  getTrendSeries: mockGetTrendSeries,
  getProductHealth: mockGetProductHealth,
}));
vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

const PROD_A = '00000000-0000-4000-8000-00000000000a';
const PROD_B = '00000000-0000-4000-8000-00000000000b';
const TENANT_A = '00000000-0000-4000-8000-00000000ee0a';
const TENANT_B = '00000000-0000-4000-8000-00000000ee0b';

async function buildHarness(
  role?: 'super_admin' | 'product_admin',
  tenant_id?: string,
) {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../biProduct.js')).default;
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: err.message });
  });
  if (role) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as {
        operator: { role: string; operator_id: string; tenant_id?: string | null };
      }).operator = {
        role,
        operator_id: 'op-1',
        tenant_id: tenant_id ?? null,
      };
    });
  }
  await app.register(routes);
  return app;
}

function stubProductLookup(productId: string, tenantId: string | null): void {
  mockPoolQuery.mockImplementation(async (_sql: unknown, params?: unknown) => {
    const paramArr = params as unknown[] | undefined;
    if (paramArr?.[0] === productId) {
      return { rows: [{ tenant_id: tenantId }] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/admin/bi/products/:productId/trends — validation', () => {
  it('400 when metric is missing', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/trends?window=daily&range=30d`,
    });
    expect(res.statusCode).toBe(400);
    expect(mockGetTrendSeries).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 when metric is not in the catalog', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/trends?metric=nope&window=daily&range=30d`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('not in catalog');
    await app.close();
  });

  it('400 when window is invalid', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/trends?metric=mrr_cents&window=weekly&range=30d`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 when range is invalid', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/trends?metric=mrr_cents&window=daily&range=180d`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/v1/admin/bi/products/:productId/trends — RBAC + happy path', () => {
  it('super_admin: 200 for any existing product', async () => {
    stubProductLookup(PROD_A, TENANT_A);
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/trends?metric=daily_active_users&window=daily&range=30d`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { series: unknown[] };
    expect(body.series).toHaveLength(2);
    expect(mockGetTrendSeries).toHaveBeenCalledOnce();
    await app.close();
  });

  it('super_admin: 404 for unknown product', async () => {
    stubProductLookup('other-id', TENANT_A);
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/trends?metric=daily_active_users&window=daily&range=30d`,
    });
    expect(res.statusCode).toBe(404);
    expect(mockGetTrendSeries).not.toHaveBeenCalled();
    await app.close();
  });

  it("product_admin: 200 when product's tenant matches operator's tenant", async () => {
    stubProductLookup(PROD_A, TENANT_A);
    const app = await buildHarness('product_admin', TENANT_A);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/trends?metric=daily_active_users&window=daily&range=30d`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("product_admin: 403 when product's tenant does NOT match operator's tenant (forge)", async () => {
    stubProductLookup(PROD_B, TENANT_A); // product's tenant is A
    const app = await buildHarness('product_admin', TENANT_B); // operator's tenant is B
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_B}/trends?metric=daily_active_users&window=daily&range=30d`,
    });
    expect(res.statusCode).toBe(403);
    expect(mockGetTrendSeries).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /api/v1/admin/bi/products/:productId/health', () => {
  it("super_admin: 200 with health payload", async () => {
    stubProductLookup(PROD_A, TENANT_A);
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/health`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { health: string };
    expect(body.health).toBe('ok');
    await app.close();
  });

  it("returns 'unknown' with reason when there is no recent metric", async () => {
    stubProductLookup(PROD_A, TENANT_A);
    mockGetProductHealth.mockResolvedValueOnce({
      product_id: PROD_A,
      health: 'unknown',
      as_of: '2026-07-13T12:00:00Z',
      reason: 'no recent metric',
    });
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/health`,
    });
    const body = JSON.parse(res.body) as { health: string; reason: string };
    expect(body.health).toBe('unknown');
    expect(body.reason).toBe('no recent metric');
    await app.close();
  });

  it("product_admin cross-tenant forge → 403", async () => {
    stubProductLookup(PROD_A, TENANT_A);
    const app = await buildHarness('product_admin', TENANT_B);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/bi/products/${PROD_A}/health`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('GET /api/v1/admin/bi/catalog', () => {
  it('403 without operator', async () => {
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/bi/catalog' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('200 for product_admin (catalog is readable by any admin)', async () => {
    const app = await buildHarness('product_admin', TENANT_A);
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/bi/catalog' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      catalog: Array<{ name: string; type: string; rollup: string }>;
    };
    expect(body.catalog.length).toBeGreaterThanOrEqual(6);
    const names = body.catalog.map((c) => c.name);
    expect(names).toContain('mrr_cents');
    expect(names).toContain('app_health_status');
    await app.close();
  });

  it('200 for super_admin', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/bi/catalog' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
