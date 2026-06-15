// Authorized by HUB-391 — unit tests: POST /api/v1/leases/issue
// Authorized by HUB-392 — unit tests: POST /api/v1/leases/verify
// Authorized by HUB-393 — unit tests: DELETE /api/v1/leases/:leaseId
// Authorized by HUB-552 — unit tests: service auth, rate limiting
// Authorized by HUB-553 — unit tests: POST /api/v1/leases/:leaseId/extend
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockIssueLease = vi.hoisted(() => vi.fn());
const mockVerifyLease = vi.hoisted(() => vi.fn());
const mockRevokeLease = vi.hoisted(() => vi.fn());
const mockExtendLease = vi.hoisted(() => vi.fn());
vi.mock('../../services/leaseService.js', () => ({
  issueLease: mockIssueLease,
  verifyLease: mockVerifyLease,
  revokeLease: mockRevokeLease,
  extendLease: mockExtendLease,
}));

// Mock bcrypt so tests don't need to hash actual passwords
const mockBcryptCompare = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('bcryptjs', () => ({ default: { compare: mockBcryptCompare } }));

// Pool mock — used by resolveServiceAuth to look up product_registrations
const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

// Redis mock — used by checkLeaseRateLimit
const mockRedisIncr = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockRedisPexpire = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockRedisPttl = vi.hoisted(() => vi.fn().mockResolvedValue(60000));
vi.mock('../../redis/client.js', () => ({
  getRedisClient: () => ({
    incr: mockRedisIncr,
    pexpire: mockRedisPexpire,
    pttl: mockRedisPttl,
  }),
}));

import leasesRoutes from '../leases.js';
import { AppError } from '../../errors/AppError.js';

// ── Test app ──────────────────────────────────────────────────────────────────

async function buildTestApp() {
  const fastify = Fastify({ logger: false });

  // Mock authenticateOperator decorator
  fastify.decorate(
    'authenticateOperator',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      (request as FastifyRequest & { operator_id: string; operator_role: string }).operator_id = 'op-1';
      (request as FastifyRequest & { operator_id: string; operator_role: string }).operator_role = 'admin';
    },
  );

  await fastify.register(leasesRoutes);
  return fastify;
}

// Default product_registrations row returned by pool mock
const FAKE_PRODUCT_ROW = {
  product_id: 'product-1',
  client_secret_hash: '$2a$10$fakehash',
};

const AUTH_HEADER = 'Basic ' + Buffer.from('client-1:secret').toString('base64');

afterEach(() => {
  vi.clearAllMocks();
  mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });
  mockBcryptCompare.mockResolvedValue(true);
  mockRedisIncr.mockResolvedValue(1);
});

// ── POST /api/v1/leases/issue ─────────────────────────────────────────────────

describe('POST /api/v1/leases/issue — success', () => {
  it('returns 200 with { signedPayload, expiresAt, renewsAt }', async () => {
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 86400000);
    mockIssueLease.mockResolvedValue({ signedPayload: 'sp-1', expiresAt: expires, renewsAt: expires });
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/issue',
        headers: { authorization: AUTH_HEADER },
        payload: { tenantId: 'tenant-1', productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ signedPayload: string; expiresAt: string; renewsAt: string }>();
      expect(body.signedPayload).toBe('sp-1');
      expect(body.expiresAt).toBeDefined();
      expect(body.renewsAt).toBeDefined();
    } finally {
      await fastify.close();
    }
  });

  it('calls issueLease with tenantId, resolved productId, sdkVersion, and raw secret', async () => {
    const expires = new Date();
    mockIssueLease.mockResolvedValue({ signedPayload: 'sp', expiresAt: expires, renewsAt: expires });
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/issue',
        headers: { authorization: AUTH_HEADER },
        payload: { tenantId: 'tenant-1', productId: 'product-1', sdkVersion: '2.0.0' },
      });
      expect(mockIssueLease).toHaveBeenCalledWith('tenant-1', 'product-1', '2.0.0', 'secret');
    } finally {
      await fastify.close();
    }
  });
});

describe('POST /api/v1/leases/issue — auth failures', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/issue',
        payload: { tenantId: 'tenant-1', productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when client_id is not found', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockBcryptCompare.mockResolvedValue(false);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/issue',
        headers: { authorization: AUTH_HEADER },
        payload: { tenantId: 'tenant-1', productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when clientSecret does not match hash', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });
    mockBcryptCompare.mockResolvedValue(false);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/issue',
        headers: { authorization: AUTH_HEADER },
        payload: { tenantId: 'tenant-1', productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });
});

describe('POST /api/v1/leases/issue — validation', () => {
  it('returns 400 when tenantId is missing', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/issue',
        headers: { authorization: AUTH_HEADER },
        payload: { productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 429 and Retry-After header when rate limit exceeded', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });
    mockRedisIncr.mockResolvedValue(9999); // way over limit
    mockRedisPttl.mockResolvedValue(30000);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/issue',
        headers: { authorization: AUTH_HEADER },
        payload: { tenantId: 'tenant-1', productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await fastify.close();
    }
  });
});

describe('POST /api/v1/leases/issue — service errors', () => {
  it('returns 403 when license is not active', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });
    mockIssueLease.mockRejectedValue(new AppError(403, 'License not active'));

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/issue',
        headers: { authorization: AUTH_HEADER },
        payload: { tenantId: 'tenant-1', productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await fastify.close();
    }
  });
});

// ── POST /api/v1/leases/verify ────────────────────────────────────────────────

describe('POST /api/v1/leases/verify', () => {
  it('returns 200 { valid: true, payload } for a valid lease', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });
    mockVerifyLease.mockResolvedValue({ valid: true, payload: { leaseId: 'lx-1' } });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/verify',
        headers: { authorization: AUTH_HEADER },
        payload: { signedPayload: '{"leaseId":"lx-1"}', clientSecret: 'secret' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ valid: boolean }>().valid).toBe(true);
    } finally {
      await fastify.close();
    }
  });

  it('returns 200 { valid: false, reason } for tampered payload — never 4xx', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });
    mockVerifyLease.mockResolvedValue({ valid: false, reason: 'invalid_signature' });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/verify',
        headers: { authorization: AUTH_HEADER },
        payload: { signedPayload: 'tampered', clientSecret: 'secret' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ valid: boolean; reason: string }>().reason).toBe('invalid_signature');
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when Authorization is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/verify',
        payload: { signedPayload: 'sp', clientSecret: 'secret' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when body is missing required fields', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [FAKE_PRODUCT_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/verify',
        headers: { authorization: AUTH_HEADER },
        payload: { signedPayload: 'sp' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});

// ── POST /api/v1/leases/:leaseId/extend ──────────────────────────────────────

describe('POST /api/v1/leases/:leaseId/extend', () => {
  it('returns 200 with { leaseId, expiresAt, renewsAt } on success', async () => {
    const newExpires = new Date('2099-12-31');
    mockExtendLease.mockResolvedValue({ leaseId: 'lease-1', expiresAt: newExpires, renewsAt: newExpires });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/lease-1/extend',
        payload: { daysToExtend: 5 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ leaseId: string }>();
      expect(body.leaseId).toBe('lease-1');
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when daysToExtend is 0', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/lease-1/extend',
        payload: { daysToExtend: 0 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when daysToExtend is not a multiple of 5 (delegated to service)', async () => {
    mockExtendLease.mockRejectedValue(new AppError(400, 'daysToExtend must be a positive multiple of 5'));
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/lease-1/extend',
        payload: { daysToExtend: 3 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 404 when lease is not found', async () => {
    mockExtendLease.mockRejectedValue(new AppError(404, 'Lease not found'));
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/lease-1/extend',
        payload: { daysToExtend: 5 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });

  it('returns 409 when lease is revoked', async () => {
    mockExtendLease.mockRejectedValue(new AppError(409, 'Lease is revoked and cannot be extended'));
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/leases/lease-1/extend',
        payload: { daysToExtend: 5 },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await fastify.close();
    }
  });
});

// ── DELETE /api/v1/leases/:leaseId ───────────────────────────────────────────

describe('DELETE /api/v1/leases/:leaseId', () => {
  it('returns 200 with { id, revoked_at, revoke_reason } on success', async () => {
    const revokedAt = new Date();
    mockRevokeLease.mockResolvedValue({
      id: 'lease-1',
      revoked_at: revokedAt,
      revoke_reason: 'policy violation',
    });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/leases/lease-1',
        payload: { reason: 'policy violation' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; revoke_reason: string }>();
      expect(body.id).toBe('lease-1');
      expect(body.revoke_reason).toBe('policy violation');
    } finally {
      await fastify.close();
    }
  });

  it('returns 404 when lease not found', async () => {
    mockRevokeLease.mockRejectedValue(new AppError(404, 'Lease not found'));
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/leases/nonexistent',
        payload: { reason: 'test' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when reason is missing from body', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: '/api/v1/leases/lease-1',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});
