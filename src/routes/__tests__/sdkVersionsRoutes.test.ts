// Authorized by HUB-1698 (E-BE-1 S21) — route tests for the 3 new sdk-versions GETs.
// Covers: 200 happy path × 3 endpoints (super_admin) + 403 product_admin × 3 +
// validation errors (INVALID_SDK_NAME for missing/malformed, INVALID_VERSION for impact)
// + 401 missing auth. RBAC hook is included in the test app to mirror real wiring.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

const mockGetDistribution = vi.hoisted(() => vi.fn());
const mockGetProductBreakdown = vi.hoisted(() => vi.fn());
const mockGetImpactPreview = vi.hoisted(() => vi.fn());
vi.mock('../../services/sdkVersionAnalyticsService.js', () => ({
  getDistribution: mockGetDistribution,
  getProductBreakdown: mockGetProductBreakdown,
  getImpactPreview: mockGetImpactPreview,
}));

vi.mock('../../services/adminSettings.js', () => ({ getSetting: vi.fn().mockResolvedValue(false) }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import adminSdkVersionsRoutes from '../admin/sdkVersions.js';
import { operatorRbacHook } from '../../hooks/operatorRbac.js';
import { AppError } from '../../errors/AppError.js';

import { closeAppResources } from '../../__tests__/_testCleanup.js';
const SECRET = 'test-secret-hub-1698';

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
    await scope.register(adminSdkVersionsRoutes);
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

describe('GET /api/v1/admin/sdk-versions/* (HUB-1698)', () => {
  describe('happy path (super_admin)', () => {
    it('distribution: returns 200 with sdkName + distribution payload', async () => {
      mockGetDistribution.mockResolvedValueOnce([
        { version: '1.0.0', count: 2, products: ['Alpha', 'Beta'] },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sdk-versions/distribution?sdkName=hub-sdk',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sdkName: 'hub-sdk',
        distribution: [{ version: '1.0.0', count: 2, products: ['Alpha', 'Beta'] }],
      });
      expect(mockGetDistribution).toHaveBeenCalledWith('hub-sdk');
    });

    it('products: returns 200 with sdkName + products breakdown', async () => {
      mockGetProductBreakdown.mockResolvedValueOnce([
        {
          productId: 'p1',
          productName: 'Alpha',
          currentVersion: '1.0.0',
          lastReportedAt: '2026-06-20T00:00:00.000Z',
          daysBehindLatest: 0,
          status: 'current',
        },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sdk-versions/products?sdkName=synapz-sdk',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sdkName).toBe('synapz-sdk');
      expect(body.products).toHaveLength(1);
      expect(body.products[0].status).toBe('current');
    });

    it('impact: returns 200 with sdkName + deprecatedVersion + impacted result', async () => {
      mockGetImpactPreview.mockResolvedValueOnce({
        impactedCount: 1,
        products: [{ productId: 'p1', productName: 'Alpha', currentVersion: '0.9.0' }],
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sdk-versions/impact?sdkName=hub-sdk&version=1.0.0',
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sdkName: 'hub-sdk',
        deprecatedVersion: '1.0.0',
        impactedCount: 1,
        products: [{ productId: 'p1', productName: 'Alpha', currentVersion: '0.9.0' }],
      });
      expect(mockGetImpactPreview).toHaveBeenCalledWith('hub-sdk', '1.0.0');
    });
  });

  describe('AC#4 — product_admin gets 403 on all 3 endpoints', () => {
    // product_admin claim with tenant_id=null fails the operatorRbacHook for any
    // resource-scoped route; here the hook passes because no path/body/query tenant_id
    // is present, so the inline super_admin check at the handler entry is what fires.
    // Use tenant_id='some-tenant' to clear the hook and reach the handler.
    const PA = (): { authorization: string } =>
      authHeader('product_admin', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    it('distribution: 403 for product_admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sdk-versions/distribution?sdkName=hub-sdk',
        headers: PA(),
      });
      // Hook denies first (product_admin requires resource tenant_id; query has none)
      expect(res.statusCode).toBe(403);
      expect(mockGetDistribution).not.toHaveBeenCalled();
    });

    it('products: 403 for product_admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sdk-versions/products?sdkName=hub-sdk',
        headers: PA(),
      });
      expect(res.statusCode).toBe(403);
      expect(mockGetProductBreakdown).not.toHaveBeenCalled();
    });

    it('impact: 403 for product_admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sdk-versions/impact?sdkName=hub-sdk&version=1.0.0',
        headers: PA(),
      });
      expect(res.statusCode).toBe(403);
      expect(mockGetImpactPreview).not.toHaveBeenCalled();
    });
  });

  describe('AC#5 — sdkName validation', () => {
    it.each([
      ['missing sdkName', '/api/v1/admin/sdk-versions/distribution'],
      ['empty sdkName', '/api/v1/admin/sdk-versions/distribution?sdkName='],
      ['uppercase sdkName', '/api/v1/admin/sdk-versions/distribution?sdkName=Hub-Sdk'],
      ['underscore sdkName', '/api/v1/admin/sdk-versions/distribution?sdkName=hub_sdk'],
      ['leading digit', '/api/v1/admin/sdk-versions/distribution?sdkName=1hub'],
    ])('returns 400 INVALID_SDK_NAME on %s', async (_label, url) => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/INVALID_SDK_NAME/);
      expect(mockGetDistribution).not.toHaveBeenCalled();
    });
  });

  describe('AC#6 — version validation on impact endpoint', () => {
    it.each([
      ['missing version', '/api/v1/admin/sdk-versions/impact?sdkName=hub-sdk'],
      ['non-semver (1.0)', '/api/v1/admin/sdk-versions/impact?sdkName=hub-sdk&version=1.0'],
      ['non-semver (latest)', '/api/v1/admin/sdk-versions/impact?sdkName=hub-sdk&version=latest'],
      [
        'non-semver (v1.0.0)',
        '/api/v1/admin/sdk-versions/impact?sdkName=hub-sdk&version=v1.0.0',
      ],
    ])('returns 400 INVALID_VERSION on %s', async (_label, url) => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/INVALID_VERSION/);
      expect(mockGetImpactPreview).not.toHaveBeenCalled();
    });
  });

  describe('auth', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/sdk-versions/distribution?sdkName=hub-sdk',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
