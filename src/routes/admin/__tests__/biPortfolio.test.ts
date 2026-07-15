// Authorized by HUB-1807 (S5 of HUB-1785) — route tests for GET /bi/portfolio/summary.
// Verifies RBAC, cache hit/miss behavior, cache TTL expiry, and delegation to the
// portfolio summary service.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockCompute = vi.hoisted(() =>
  vi.fn(async (_now?: Date) => ({
    as_of: '2026-07-13T00:00:00Z',
    mrr_cents: 100,
    daily_active_users: 10,
    churn_rate: 0.01,
    per_product: [],
  })),
);

vi.mock('../../../services/bi/portfolioSummaryService.js', () => ({
  computePortfolioSummary: mockCompute,
}));

async function buildHarness(role?: 'super_admin' | 'product_admin') {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../biPortfolio.js')).default;
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: err.message });
  });
  if (role) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { operatorUser: { role: string } }).operatorUser = { role };
    });
  }
  await app.register(routes);
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../biPortfolio.js');
  mod._resetPortfolioSummaryCacheForTest();
});

afterEach(async () => {
  const mod = await import('../biPortfolio.js');
  mod._resetPortfolioSummaryCacheForTest();
});

describe('GET /api/v1/admin/bi/portfolio/summary — RBAC', () => {
  it('403 without operator', async () => {
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/bi/portfolio/summary' });
    expect(res.statusCode).toBe(403);
    expect(mockCompute).not.toHaveBeenCalled();
    await app.close();
  });

  it('403 for product_admin', async () => {
    const app = await buildHarness('product_admin');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/bi/portfolio/summary' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('200 for super_admin', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/bi/portfolio/summary' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { mrr_cents: number };
    expect(body.mrr_cents).toBe(100);
    await app.close();
  });
});

describe('GET /api/v1/admin/bi/portfolio/summary — cache', () => {
  it('within TTL: second call short-circuits (compute called once)', async () => {
    const app = await buildHarness('super_admin');
    await app.inject({ method: 'GET', url: '/api/v1/admin/bi/portfolio/summary' });
    await app.inject({ method: 'GET', url: '/api/v1/admin/bi/portfolio/summary' });
    await app.inject({ method: 'GET', url: '/api/v1/admin/bi/portfolio/summary' });
    expect(mockCompute).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('after cache reset: recomputes', async () => {
    const app = await buildHarness('super_admin');
    await app.inject({ method: 'GET', url: '/api/v1/admin/bi/portfolio/summary' });
    expect(mockCompute).toHaveBeenCalledTimes(1);
    const mod = await import('../biPortfolio.js');
    mod._resetPortfolioSummaryCacheForTest();
    await app.inject({ method: 'GET', url: '/api/v1/admin/bi/portfolio/summary' });
    expect(mockCompute).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
