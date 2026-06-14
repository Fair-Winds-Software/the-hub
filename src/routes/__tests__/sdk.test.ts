// Authorized by HUB-349 — unit tests for POST /api/v1/sdk/version-report
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ── Service mock ──────────────────────────────────────────────────────────────
const mockRecordSdkVersion = vi.hoisted(() => vi.fn());
vi.mock('../../services/versionReporting.js', () => ({
  recordSdkVersion: mockRecordSdkVersion,
}));

import sdkRoutes from '../sdk.js';
import { AppError } from '../../errors/AppError.js';

async function buildTestApp() {
  const fastify = Fastify({ logger: false });
  // Mock authenticate decorator — sets tenant_id on every request
  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      (request as FastifyRequest & { tenant_id: string; product_id: string }).tenant_id = 'tenant-1';
      (request as FastifyRequest & { tenant_id: string; product_id: string }).product_id = 'product-1';
    },
  );
  await fastify.register(sdkRoutes);
  return fastify;
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── POST /api/v1/sdk/version-report ──────────────────────────────────────────

describe('POST /api/v1/sdk/version-report — success', () => {
  it('returns 200 with the upserted row', async () => {
    const row = { id: 'svr-1', tenant_id: 'tenant-1', product_id: 'product-1', sdk_version: '1.0.0', reported_at: new Date().toISOString() };
    mockRecordSdkVersion.mockResolvedValueOnce(row);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/sdk/version-report',
        payload: { productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ sdk_version: '1.0.0' });
    } finally {
      await fastify.close();
    }
  });

  it('resolves tenantId from auth context — not from request body', async () => {
    mockRecordSdkVersion.mockResolvedValueOnce({ id: 'svr-1', tenant_id: 'tenant-1', sdk_version: '1.0.0' });

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'POST',
        url: '/api/v1/sdk/version-report',
        payload: { productId: 'product-1', sdkVersion: '1.0.0' },
      });
      expect(mockRecordSdkVersion).toHaveBeenCalledWith('tenant-1', 'product-1', '1.0.0');
    } finally {
      await fastify.close();
    }
  });
});

describe('POST /api/v1/sdk/version-report — validation errors', () => {
  it('returns 400 when productId is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/sdk/version-report',
        payload: { sdkVersion: '1.0.0' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when sdkVersion is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/sdk/version-report',
        payload: { productId: 'product-1' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('strips extra body fields silently — auth context tenantId cannot be overridden via body', async () => {
    mockRecordSdkVersion.mockResolvedValueOnce({ id: 'svr-1', tenant_id: 'tenant-1', sdk_version: '1.0.0' });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/sdk/version-report',
        // additionalProperties: false causes Fastify to strip tenantId before handler runs
        payload: { productId: 'product-1', sdkVersion: '1.0.0', tenantId: 'attacker-tenant' },
      });
      // Request succeeds; body tenantId was stripped by schema validation
      expect(res.statusCode).toBe(200);
      // Service was called with auth-context tenantId ('tenant-1'), not body tenantId
      expect(mockRecordSdkVersion).toHaveBeenCalledWith('tenant-1', 'product-1', '1.0.0');
    } finally {
      await fastify.close();
    }
  });
});

describe('POST /api/v1/sdk/version-report — service errors', () => {
  it('returns 403 when version is sunset', async () => {
    mockRecordSdkVersion.mockRejectedValueOnce(new AppError(403, 'SDK version sunset; upgrade required'));

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/sdk/version-report',
        payload: { productId: 'product-1', sdkVersion: '0.1.0' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await fastify.close();
    }
  });

  it('returns 404 when version is unknown', async () => {
    mockRecordSdkVersion.mockRejectedValueOnce(new AppError(404, 'Unknown SDK version'));

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/sdk/version-report',
        payload: { productId: 'product-1', sdkVersion: '99.0.0' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });
});
