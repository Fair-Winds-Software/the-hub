// Authorized by HUB-1697 (E-BE-1 S20) — route tests for GET /api/v1/admin/console/audit-log
// extension. Covers: super_admin filter combos + sort + product_admin RBAC (PRODUCT_ID_REQUIRED
// 400, FORBIDDEN 403 for out-of-tenant product, allowed for in-tenant product) + date range
// validation (INVALID_DATE_RANGE, RANGE_TOO_LARGE) + invalid sort + backward compatibility +
// operatorRbacHook query.tenant_id extension.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockGetAuditLog = vi.hoisted(() => vi.fn());
vi.mock('../../services/operatorConsoleService.js', () => ({
  getAuditLog: mockGetAuditLog,
  // Pass-through stubs for other exports the route module imports.
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
}));

// adminSettings.getSetting is read by the operatorRbacHook compat-window check —
// stub to a benign false so legacy tenant_admin claims stay rejected.
vi.mock('../../services/adminSettings.js', () => ({ getSetting: vi.fn().mockResolvedValue(false) }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import adminOperatorConsoleRoutes from '../admin/operatorConsole.js';
import { operatorRbacHook } from '../../hooks/operatorRbac.js';
import { AppError } from '../../errors/AppError.js';

import { closeAppResources } from '../../__tests__/_testCleanup.js';
const SECRET = 'test-secret-hub-1697';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // belongs to TENANT_A
const PRODUCT_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd'; // belongs to TENANT_B

const RESULT_FIXTURE = { data: [], total: 0, limit: 50, offset: 0 };

let app: FastifyInstance;

beforeAll(async () => {
  process.env.OPERATOR_JWT_SECRET = SECRET;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  // Mirror the adminRoutes plugin structure: register the RBAC hook for the inner scope.
  await app.register(async (scope) => {
    scope.addHook('onRequest', operatorRbacHook);
    await scope.register(adminOperatorConsoleRoutes);
  });
  await app.ready();
});

afterAll(async () => {
  await closeAppResources(app);
});

beforeEach(() => {
  vi.clearAllMocks();
});

function tokenFor(role: 'super_admin' | 'product_admin', tenantId: string | null) {
  return jwt.sign(
    { operator_id: 'op-1', role, tenant_id: tenantId },
    SECRET,
    { expiresIn: '1h' },
  );
}

function authHeader(role: 'super_admin' | 'product_admin', tenantId: string | null = null) {
  return { authorization: `Bearer ${tokenFor(role, tenantId)}` };
}

describe('GET /api/v1/admin/console/audit-log (HUB-1697 extension)', () => {
  describe('super_admin — all filters honored', () => {
    it('AC#1+2: actor + action (multi) + entity_type (multi) + from/to + sort all pass to service', async () => {
      mockGetAuditLog.mockResolvedValueOnce(RESULT_FIXTURE);

      const res = await app.inject({
        method: 'GET',
        url:
          '/api/v1/admin/console/audit-log?' +
          [
            `tenant_id=${TENANT_A}`,
            'actor=op-deadbeef',
            'action=login,logout',
            'entity_type=tenant,product',
            'from=2026-05-01T00:00:00Z',
            'to=2026-05-31T23:59:59Z',
            'sort=created_at:asc',
            'limit=25',
          ].join('&'),
        headers: authHeader('super_admin'),
      });

      expect(res.statusCode).toBe(200);
      const [opts] = mockGetAuditLog.mock.calls[0]!;
      expect(opts).toMatchObject({
        tenantId: TENANT_A,
        productId: undefined,
        actor: 'op-deadbeef',
        actions: ['login', 'logout'],
        entityTypes: ['tenant', 'product'],
        sort: 'asc',
        limit: 25,
      });
      expect(opts.from.toISOString()).toBe('2026-05-01T00:00:00.000Z');
      expect(opts.to.toISOString()).toBe('2026-05-31T23:59:59.000Z');
    });

    it('AC#1: default sort is descending when omitted', async () => {
      mockGetAuditLog.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}`,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockGetAuditLog.mock.calls[0]!;
      expect(opts.sort).toBe('desc');
    });

    it('AC#4: response shape unchanged ({data, total, limit, offset})', async () => {
      mockGetAuditLog.mockResolvedValueOnce({
        data: [{ id: 'r1', action: 'login' }],
        total: 1,
        limit: 50,
        offset: 0,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}`,
        headers: authHeader('super_admin'),
      });
      expect(res.json()).toEqual({
        data: [{ id: 'r1', action: 'login' }],
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    it('backward compat: tenant_id-only request still works', async () => {
      mockGetAuditLog.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}`,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      const [opts] = mockGetAuditLog.mock.calls[0]!;
      expect(opts.actor).toBeUndefined();
      expect(opts.actions).toBeUndefined();
      expect(opts.from).toBeUndefined();
    });
  });

  describe('AC#3 — date range validation', () => {
    it('returns 400 INVALID_DATE_RANGE when from > to', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}&from=2026-06-01&to=2026-05-01`,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/INVALID_DATE_RANGE/);
      expect(mockGetAuditLog).not.toHaveBeenCalled();
    });

    it('returns 400 RANGE_TOO_LARGE when range exceeds 365 days', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}&from=2025-01-01&to=2026-06-01`,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/RANGE_TOO_LARGE/);
      expect(mockGetAuditLog).not.toHaveBeenCalled();
    });

    it('returns 400 on malformed from date', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}&from=not-a-date`,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/from must be a valid ISO8601/);
    });
  });

  describe('AC#1 — sort validation', () => {
    it('returns 400 on invalid sort value', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}&sort=action:asc`,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/sort must be created_at/);
    });
  });

  describe('AC#5 — product_admin RBAC', () => {
    it('returns 400 PRODUCT_ID_REQUIRED when product_admin omits product_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}`,
        headers: authHeader('product_admin', TENANT_A),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/PRODUCT_ID_REQUIRED/);
      expect(mockGetAuditLog).not.toHaveBeenCalled();
    });

    it('returns 200 when product_admin queries in-tenant product_id', async () => {
      // products ownership check returns 1 row → allowed
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: PRODUCT_A }] });
      mockGetAuditLog.mockResolvedValueOnce(RESULT_FIXTURE);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}&product_id=${PRODUCT_A}`,
        headers: authHeader('product_admin', TENANT_A),
      });

      expect(res.statusCode).toBe(200);
      const [sql, params] = mockPoolQuery.mock.calls[0]!;
      expect(sql).toMatch(/FROM products WHERE id = \$1 AND tenant_id = \$2/);
      expect(params).toEqual([PRODUCT_A, TENANT_A]);
    });

    it('returns 403 FORBIDDEN when product_admin queries out-of-tenant product_id', async () => {
      // products ownership check returns 0 rows → forbidden
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}&product_id=${PRODUCT_B}`,
        headers: authHeader('product_admin', TENANT_A),
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/FORBIDDEN/);
      expect(mockGetAuditLog).not.toHaveBeenCalled();
    });

    it('returns 403 when product_admin requests a different tenant (operatorRbacHook)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_B}&product_id=${PRODUCT_A}`,
        headers: authHeader('product_admin', TENANT_A), // claim says A, query says B
      });
      // The hook fires first and 403s before the handler runs.
      expect(res.statusCode).toBe(403);
      expect(mockGetAuditLog).not.toHaveBeenCalled();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('AC#5 — super_admin unrestricted', () => {
    it('super_admin without product_id is allowed (portfolio-wide)', async () => {
      mockGetAuditLog.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}`,
        headers: authHeader('super_admin'),
      });
      expect(res.statusCode).toBe(200);
      expect(mockPoolQuery).not.toHaveBeenCalled(); // no products ownership lookup
    });

    it('super_admin with product_id skips ownership check', async () => {
      mockGetAuditLog.mockResolvedValueOnce(RESULT_FIXTURE);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}&product_id=${PRODUCT_B}`,
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
        url: `/api/v1/admin/console/audit-log?tenant_id=${TENANT_A}`,
      });
      expect(res.statusCode).toBe(401);
      expect(mockGetAuditLog).not.toHaveBeenCalled();
    });
  });
});
