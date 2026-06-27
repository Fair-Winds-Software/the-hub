// Authorized by HUB-1596 (E-BE-1 S13, CR-3) — route tests for GET /api/v1/analytics/portfolio-margin.
// Mocks getPortfolioMargin (HUB-1595) + jwt verification; uses Fastify inject to drive HTTP.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockGetPortfolioMargin = vi.hoisted(() => vi.fn());
vi.mock('../../services/analyticsService.js', () => ({
  getPortfolioMargin: mockGetPortfolioMargin,
  // Pass-throughs for other exports the route module imports.
  getUsageAnalytics: vi.fn(),
  getBillingAnalytics: vi.fn(),
}));

const mockJwtVerify = vi.hoisted(() => vi.fn());
vi.mock('jsonwebtoken', () => ({
  default: { verify: mockJwtVerify },
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import analyticsRoutes from '../analyticsRoutes.js';
import { AppError } from '../../errors/AppError.js';

const RESULT_FIXTURE = {
  from: '2026-05-01T00:00:00.000Z',
  to: '2026-05-31T23:59:59.000Z',
  generatedAt: '2026-06-27T00:00:00.000Z',
  threshold: 0.0,
  products: [
    {
      productId: 'p1',
      productName: 'Alpha',
      revenueCents: 10000,
      costCents: 4000,
      marginPct: 0.6,
      losingMoney: false,
    },
  ],
  portfolio: { revenueCents: 10000, costCents: 4000, marginPct: 0.6, losingMoney: false },
};

let app: FastifyInstance;

beforeAll(async () => {
  process.env.OPERATOR_JWT_SECRET = 'test-secret';
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  await app.register(analyticsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function authFor(role: 'super_admin' | 'product_admin' = 'super_admin') {
  mockJwtVerify.mockReturnValue({
    operator_id: 'op-1',
    role,
    tenant_id: null,
  });
  return { authorization: 'Bearer fake-token' };
}

describe('GET /api/v1/analytics/portfolio-margin (HUB-1596)', () => {
  it('returns 200 with available:true and the aggregator result on happy path', async () => {
    mockGetPortfolioMargin.mockResolvedValueOnce(RESULT_FIXTURE);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/portfolio-margin?from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z',
      headers: authFor(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      available: true,
      threshold: 0,
      portfolio: RESULT_FIXTURE.portfolio,
    });
    const [params] = mockGetPortfolioMargin.mock.calls[0]!;
    expect(params.from.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(params.to.toISOString()).toBe('2026-05-31T23:59:59.000Z');
  });

  it('defaults to last-30-days when from + to are omitted', async () => {
    mockGetPortfolioMargin.mockResolvedValueOnce(RESULT_FIXTURE);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/portfolio-margin',
      headers: authFor(),
    });

    expect(res.statusCode).toBe(200);
    const [params] = mockGetPortfolioMargin.mock.calls[0]!;
    const diffMs = params.to.getTime() - params.from.getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
  });

  it('returns 400 RANGE_INVERTED when from > to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/portfolio-margin?from=2026-06-01&to=2026-05-01',
      headers: authFor(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'RANGE_INVERTED' });
    expect(mockGetPortfolioMargin).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_DATE on malformed from', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/portfolio-margin?from=not-a-date',
      headers: authFor(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/from is not a valid/);
    expect(mockGetPortfolioMargin).not.toHaveBeenCalled();
  });

  it('returns 400 when getPortfolioMargin throws AppError(400) for >90-day range', async () => {
    mockGetPortfolioMargin.mockRejectedValueOnce(new AppError(400, 'Time range must not exceed 90 days'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/portfolio-margin?from=2026-01-01&to=2026-12-31',
      headers: authFor(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Time range must not exceed 90 days' });
  });

  it('R1 contract: returns 200 + {available:false} when getPortfolioMargin throws a non-AppError', async () => {
    mockGetPortfolioMargin.mockRejectedValueOnce(new Error('DB unreachable'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/portfolio-margin?from=2026-05-01&to=2026-05-31',
      headers: authFor(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: 'upstream_unavailable' });
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/portfolio-margin',
    });

    expect(res.statusCode).toBe(401);
    expect(mockGetPortfolioMargin).not.toHaveBeenCalled();
  });

  it('product_admin is allowed (read-only signal, no PII)', async () => {
    mockGetPortfolioMargin.mockResolvedValueOnce(RESULT_FIXTURE);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/portfolio-margin',
      headers: authFor('product_admin'),
    });

    expect(res.statusCode).toBe(200);
  });
});
