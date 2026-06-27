// Authorized by HUB-1700 (E-BE-1 S23) — route tests for GET /api/v1/admin/portfolio/products.
// Covers super_admin (no scope) + product_admin (single-tenant scoping) + defensive product_admin
// without tenant_id claim (403) + limit cap + search passthrough + 401 missing auth.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

const mockGetPortfolioProducts = vi.hoisted(() => vi.fn());
vi.mock('../../services/portfolioService.js', () => ({
  getPortfolioProducts: mockGetPortfolioProducts,
}));

vi.mock('../../services/operatorConsoleService.js', () => ({
  // Pass-through stubs for the other exports the route module imports.
  getPricingOverview: vi.fn(),
  getTenantList: vi.fn(),
  assignPlan: vi.fn(),
  assignPlanBulk: vi.fn(),
  listDiscounts: vi.fn(),
  applyDiscount: vi.fn(),
  deleteDiscount: vi.fn(),
  listOverrides: vi.fn(),
  applyOverride: vi.fn(),
  deleteOverride: vi.fn(),
  getAuditLog: vi.fn(),
}));

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

vi.mock('../../services/adminSettings.js', () => ({ getSetting: vi.fn().mockResolvedValue(false) }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import adminOperatorConsoleRoutes from '../admin/operatorConsole.js';
import { operatorRbacHook } from '../../hooks/operatorRbac.js';
import { AppError } from '../../errors/AppError.js';

const SECRET = 'test-secret-hub-1700';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RESULT_FIXTURE = { data: [], total: 0 };

let app: FastifyInstance;

beforeAll(async () => {
  process.env.OPERATOR_JWT_SECRET = SECRET;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  await app.register(async (scope) => {
    scope.addHook('onRequest', operatorRbacHook);
    await scope.register(adminOperatorConsoleRoutes);
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function tokenFor(role: 'super_admin' | 'product_admin', tenantId: string | null = null) {
  return jwt.sign(
    { operator_id: 'op-1', role, tenant_id: tenantId },
    SECRET,
    { expiresIn: '1h' },
  );
}

function authHeader(role: 'super_admin' | 'product_admin', tenantId: string | null = null) {
  return { authorization: `Bearer ${tokenFor(role, tenantId)}` };
}

describe('GET /api/v1/admin/portfolio/products (HUB-1700)', () => {
  describe('super_admin (unscoped)', () => {
    it('returns 200 and service is called with operatorTenantId=null', async () => {
      mockGetPortfolioProducts.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/portfolio/products',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockGetPortfolioProducts.mock.calls[0]!;
      expect(opts.operatorTenantId).toBeNull();
      expect(opts.limit).toBe(100);
      expect(opts.offset).toBe(0);
    });

    it('passes search query through to service', async () => {
      mockGetPortfolioProducts.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/portfolio/products?search=Alpha',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockGetPortfolioProducts.mock.calls[0]!;
      expect(opts.search).toBe('Alpha');
    });

    it('limit=300 is capped at 200', async () => {
      mockGetPortfolioProducts.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/portfolio/products?limit=300',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockGetPortfolioProducts.mock.calls[0]!;
      expect(opts.limit).toBe(200);
    });

    it('offset is clamped to >= 0', async () => {
      mockGetPortfolioProducts.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/portfolio/products?offset=-5',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockGetPortfolioProducts.mock.calls[0]!;
      expect(opts.offset).toBe(0);
    });

    it('passes through response body shape from service', async () => {
      mockGetPortfolioProducts.mockResolvedValueOnce({
        data: [
          {
            productId: 'p1',
            productName: 'Alpha',
            tenantId: TENANT_A,
            tenantName: 'Acme',
            status: 'active',
            mrrCents: 100,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastActiveAt: null,
          },
        ],
        total: 1,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/portfolio/products',
        headers: authHeader('super_admin'),
      });
      expect(res.json()).toEqual({
        data: [
          {
            productId: 'p1',
            productName: 'Alpha',
            tenantId: TENANT_A,
            tenantName: 'Acme',
            status: 'active',
            mrrCents: 100,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastActiveAt: null,
          },
        ],
        total: 1,
      });
    });
  });

  describe('product_admin (single-tenant scope)', () => {
    it('passes operatorTenantId from claim through to service', async () => {
      mockGetPortfolioProducts.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/portfolio/products?tenant_id=${TENANT_A}`,
        headers: authHeader('product_admin', TENANT_A),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockGetPortfolioProducts.mock.calls[0]!;
      expect(opts.operatorTenantId).toBe(TENANT_A);
    });

    it('cross-tenant request is denied by operatorRbacHook (403)', async () => {
      const res = await app.inject({
        method: 'GET',
        // claim says A, query says B → hook 403s before handler
        url: `/api/v1/admin/portfolio/products?tenant_id=${TENANT_B}`,
        headers: authHeader('product_admin', TENANT_A),
      });
      expect(res.statusCode).toBe(403);
      expect(mockGetPortfolioProducts).not.toHaveBeenCalled();
    });

    it('product_admin without tenant_id claim → hook 403s (defensive)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/portfolio/products',
        headers: authHeader('product_admin', null),
      });
      // Hook denies because no resource tenant present + claim tenant_id is null.
      expect(res.statusCode).toBe(403);
      expect(mockGetPortfolioProducts).not.toHaveBeenCalled();
    });
  });

  describe('auth', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/portfolio/products',
      });
      expect(res.statusCode).toBe(401);
      expect(mockGetPortfolioProducts).not.toHaveBeenCalled();
    });
  });
});
