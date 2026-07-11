// Authorized by HUB-1588 — backward-compat window unit tests for the operatorRbac hook.
// Verifies the legacy `tenant_admin` JWT claim is accepted iff // tenant-admin-rename:fixture
// settings.role_rename_compat_window_enabled === true, normalized to `product_admin`
// in request.operatorUser, and rejected otherwise (fail-secure on settings fetch error).
//
// Settings reader and logger are mocked; we test the boundary logic only.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.hoisted(() => vi.fn());
vi.mock('../../services/adminSettings.js', () => ({
  getSetting: mockGetSetting,
}));

const mockLoggerInfo = vi.hoisted(() => vi.fn());
vi.mock('../../lib/logger.js', () => ({
  default: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}));

const mockJwtVerify = vi.hoisted(() => vi.fn());
vi.mock('jsonwebtoken', () => ({
  default: { verify: mockJwtVerify },
}));

import { operatorRbacHook } from '../operatorRbac.js';

interface FakeRequest {
  headers: { authorization?: string };
  params: Record<string, unknown>;
  body: Record<string, unknown> | null;
  operatorUser?: {
    operator_id: string;
    role: 'super_admin' | 'product_admin';
    tenant_id: string | null;
  };
}

function buildRequest(
  token: string,
  params: Record<string, unknown> = {},
  body: Record<string, unknown> | null = null,
  routeConfig?: { operatorSelfScoped?: boolean },
): FakeRequest & { routeOptions?: { config: unknown } } {
  return {
    headers: { authorization: `Bearer ${token}` },
    params,
    body,
    ...(routeConfig ? { routeOptions: { config: routeConfig } } : {}),
  };
}

const FAKE_REPLY = {} as never;
const TENANT_A = '00000000-0000-0000-0000-000000000aaa';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPERATOR_JWT_SECRET = 'test-secret';
});

describe('operatorRbacHook compat window (HUB-1588)', () => {
  describe('canonical claims (no compat window dependency)', () => {
    it('accepts super_admin claim and bypasses tenant_id check', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-super',
        role: 'super_admin',
        tenant_id: null,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = buildRequest('any-token');
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).resolves.toBeUndefined();
      expect(req.operatorUser?.role).toBe('super_admin');
      expect(mockGetSetting).not.toHaveBeenCalled();
    });

    it('accepts product_admin claim with matching tenant_id', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-prod',
        role: 'product_admin',
        tenant_id: TENANT_A,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = buildRequest('any-token', { tenantId: TENANT_A });
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).resolves.toBeUndefined();
      expect(req.operatorUser?.role).toBe('product_admin');
      expect(mockGetSetting).not.toHaveBeenCalled();
    });
  });

  describe('legacy tenant_admin claim during compat window', () => { // tenant-admin-rename:fixture
    it('accepts when flag = true; normalizes role to product_admin; logs telemetry', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-legacy',
        role: 'tenant_admin', // tenant-admin-rename:fixture
        tenant_id: TENANT_A,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockGetSetting.mockResolvedValueOnce(true);

      const req = buildRequest('any-token', { tenantId: TENANT_A });
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).resolves.toBeUndefined();

      expect(req.operatorUser?.role).toBe('product_admin');
      expect(mockGetSetting).toHaveBeenCalledWith('role_rename_compat_window_enabled');
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'jwt.legacy_claim_accepted',
          operator_id: 'op-legacy',
        }),
        expect.stringContaining('legacy'),
      );
    });

    it('rejects with 403 when flag = false', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-legacy',
        role: 'tenant_admin', // tenant-admin-rename:fixture
        tenant_id: TENANT_A,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockGetSetting.mockResolvedValueOnce(false);

      const req = buildRequest('any-token', { tenantId: TENANT_A });
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(req.operatorUser).toBeUndefined();
      expect(mockLoggerInfo).not.toHaveBeenCalled();
    });

    it('fail-secure: rejects with 403 when settings fetch throws', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-legacy',
        role: 'tenant_admin', // tenant-admin-rename:fixture
        tenant_id: TENANT_A,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockGetSetting.mockRejectedValueOnce(new Error('Redis + DB both down'));

      const req = buildRequest('any-token', { tenantId: TENANT_A });
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('rejects with 403 when flag is undefined (key not seeded)', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-legacy',
        role: 'tenant_admin', // tenant-admin-rename:fixture
        tenant_id: TENANT_A,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockGetSetting.mockResolvedValueOnce(undefined);

      const req = buildRequest('any-token', { tenantId: TENANT_A });
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('rejects with 403 when flag is truthy-but-not-boolean (e.g., string "true")', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-legacy',
        role: 'tenant_admin', // tenant-admin-rename:fixture
        tenant_id: TENANT_A,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockGetSetting.mockResolvedValueOnce('true'); // wrong type; strict === check

      const req = buildRequest('any-token', { tenantId: TENANT_A });
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });

  describe('post-normalize RBAC continues to enforce tenant scoping', () => {
    it('legacy claim with mismatched tenant_id receives 403 even with flag = true', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-legacy',
        role: 'tenant_admin', // tenant-admin-rename:fixture
        tenant_id: TENANT_A,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockGetSetting.mockResolvedValueOnce(true);

      const otherTenant = '00000000-0000-0000-0000-000000000bbb';
      const req = buildRequest('any-token', { tenantId: otherTenant });

      await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
        statusCode: 403,
      });
      // The legacy-accept log fired before tenant mismatch was detected, which is fine —
      // the audit trail captures the attempted access.
      expect(mockLoggerInfo).toHaveBeenCalled();
    });
  });

  describe('input validation (unchanged from HUB-1034)', () => {
    it('rejects missing Authorization header with 401', async () => {
      const req: FakeRequest = { headers: {}, params: {}, body: null };
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('rejects unknown role string with 401', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-x',
        role: 'unknown_role',
        tenant_id: null,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const req = buildRequest('any-token');
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('rejects JWT with no exp with 401', async () => {
      mockJwtVerify.mockReturnValueOnce({
        operator_id: 'op-noexp',
        role: 'super_admin',
        tenant_id: null,
        // exp deliberately absent
      });
      const req = buildRequest('any-token');
      await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
        statusCode: 401,
      });
    });
  });
});

// ── HUB-1772: operatorSelfScoped route config flag ────────────────────────────
describe('operatorRbacHook — operatorSelfScoped flag (HUB-1772)', () => {
  it('bypasses the resource-tenant check for product_admin on flagged routes', async () => {
    mockJwtVerify.mockReturnValueOnce({
      operator_id: 'op-prod',
      role: 'product_admin',
      tenant_id: TENANT_A,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    // No params.tenantId, no body.tenant_id, no query.tenant_id — pre-fix this 403'd.
    const req = buildRequest('any-token', {}, null, { operatorSelfScoped: true });
    await expect(operatorRbacHook(req as never, FAKE_REPLY)).resolves.toBeUndefined();
    expect(req.operatorUser?.role).toBe('product_admin');
    expect(req.operatorUser?.tenant_id).toBe(TENANT_A);
  });

  it('still enforces resource-tenant when flag is false / absent', async () => {
    mockJwtVerify.mockReturnValueOnce({
      operator_id: 'op-prod',
      role: 'product_admin',
      tenant_id: TENANT_A,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = buildRequest('any-token'); // no flag
    await expect(operatorRbacHook(req as never, FAKE_REPLY)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('super_admin passes the flagged route regardless (early-return before flag check)', async () => {
    mockJwtVerify.mockReturnValueOnce({
      operator_id: 'op-super',
      role: 'super_admin',
      tenant_id: null,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = buildRequest('any-token', {}, null, { operatorSelfScoped: true });
    await expect(operatorRbacHook(req as never, FAKE_REPLY)).resolves.toBeUndefined();
    expect(req.operatorUser?.role).toBe('super_admin');
  });
});
