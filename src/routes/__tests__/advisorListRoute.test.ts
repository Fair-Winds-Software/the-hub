// Authorized by HUB-1699 (E-BE-1 S22) — route tests for GET /api/v1/admin/advisor/recommendations.
// Covers: super_admin (no filter / outcome single / outcome multi / invalid productId / invalid outcome / limit cap),
// product_admin RBAC (PRODUCT_ID_REQUIRED 400, FORBIDDEN 403 out-of-tenant, allowed in-tenant),
// 401 missing auth.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockListRecommendations = vi.hoisted(() => vi.fn());
vi.mock('../../services/planAdvisorService.js', () => ({
  listRecommendations: mockListRecommendations,
  // Pass-through stubs for other exports the route module imports.
  runAdvisor: vi.fn(),
  getLatestRecommendation: vi.fn(),
  recordOutcome: vi.fn(),
  getPortfolioSummary: vi.fn(),
  getBillingSummary: vi.fn(),
  addAuditNote: vi.fn(),
  getRecommendationHistory: vi.fn(),
}));

vi.mock('../../services/adminSettings.js', () => ({ getSetting: vi.fn().mockResolvedValue(false) }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import adminAdvisorRoutes from '../admin/advisor.js';
import { operatorRbacHook } from '../../hooks/operatorRbac.js';
import { AppError } from '../../errors/AppError.js';

import { closeAppResources } from '../../__tests__/_testCleanup.js';
const SECRET = 'test-secret-hub-1699';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // belongs to TENANT_A
const PRODUCT_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd'; // does NOT belong to TENANT_A
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
    await scope.register(adminAdvisorRoutes);
  });
  await app.ready();
});

afterAll(async () => {
  await closeAppResources(app);
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

describe('GET /api/v1/admin/advisor/recommendations (HUB-1699)', () => {
  describe('super_admin happy paths', () => {
    it('no filter → 200, service called with empty opts', async () => {
      mockListRecommendations.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/advisor/recommendations',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockListRecommendations.mock.calls[0]!;
      expect(opts).toMatchObject({ productId: undefined, outcomes: undefined });
    });

    it('outcome=won → 200, service receives outcomes=["won"]', async () => {
      mockListRecommendations.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/advisor/recommendations?outcome=won',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockListRecommendations.mock.calls[0]!;
      expect(opts.outcomes).toEqual(['won']);
    });

    it('outcome=won,lost,applied (multi mixing old + new enum values) → 200', async () => {
      mockListRecommendations.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/advisor/recommendations?outcome=won,lost,applied',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockListRecommendations.mock.calls[0]!;
      expect(opts.outcomes).toEqual(['won', 'lost', 'applied']);
    });

    it('limit=300 is capped at 200', async () => {
      mockListRecommendations.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/advisor/recommendations?limit=300',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockListRecommendations.mock.calls[0]!;
      expect(opts.limit).toBe(200);
    });
  });

  describe('validation (NO service call)', () => {
    it('returns 400 on invalid productId UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/advisor/recommendations?productId=not-a-uuid',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/productId must be a valid UUID/);
      expect(mockListRecommendations).not.toHaveBeenCalled();
    });

    it('returns 400 INVALID_OUTCOME when outcome value is unknown', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/advisor/recommendations?outcome=bogus',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/INVALID_OUTCOME/);
      expect(mockListRecommendations).not.toHaveBeenCalled();
    });

    it('returns 400 INVALID_OUTCOME if even one value in csv is invalid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/advisor/recommendations?outcome=won,bogus,lost',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/INVALID_OUTCOME/);
    });
  });

  describe('product_admin RBAC', () => {
    it('returns 400 PRODUCT_ID_REQUIRED when product_admin omits productId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/advisor/recommendations?tenant_id=${TENANT_A}`,
        headers: authHeader('product_admin', TENANT_A),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/PRODUCT_ID_REQUIRED/);
      expect(mockListRecommendations).not.toHaveBeenCalled();
    });

    it('returns 200 when product_admin queries in-tenant productId', async () => {
      // products ownership check returns 1 row → allowed
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: PRODUCT_A }] });
      mockListRecommendations.mockResolvedValueOnce(RESULT_FIXTURE);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/advisor/recommendations?tenant_id=${TENANT_A}&productId=${PRODUCT_A}`,
        headers: authHeader('product_admin', TENANT_A),
      });

      expect(res.statusCode).toBe(200);
      const [sql, params] = mockPoolQuery.mock.calls[0]!;
      expect(sql).toMatch(/FROM products WHERE id = \$1 AND tenant_id = \$2/);
      expect(params).toEqual([PRODUCT_A, TENANT_A]);
    });

    it('returns 403 FORBIDDEN when product_admin queries out-of-tenant productId', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // 0 rows → forbidden

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/advisor/recommendations?tenant_id=${TENANT_A}&productId=${PRODUCT_B}`,
        headers: authHeader('product_admin', TENANT_A),
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/FORBIDDEN/);
      expect(mockListRecommendations).not.toHaveBeenCalled();
    });

    it('super_admin with productId skips the ownership check', async () => {
      mockListRecommendations.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/advisor/recommendations?productId=${PRODUCT_B}`,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('auth', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/advisor/recommendations',
      });
      expect(res.statusCode).toBe(401);
      expect(mockListRecommendations).not.toHaveBeenCalled();
    });
  });
});
