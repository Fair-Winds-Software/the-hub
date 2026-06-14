// Authorized by HUB-350 — unit tests for GET /api/v1/products/:productId/versions
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ── DB pool mock ──────────────────────────────────────────────────────────────
const mockQuery = vi.fn();
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockQuery }) }));

import versionsRoutes from '../versions.js';

async function buildTestApp() {
  const fastify = Fastify({ logger: false });
  // Mock authenticateOperator decorator
  fastify.decorate(
    'authenticateOperator',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      request.operator_id = 'op-1';
      request.operator_role = 'admin';
    },
  );
  await fastify.register(versionsRoutes);
  return fastify;
}

afterEach(() => {
  vi.clearAllMocks();
});

const sampleVersions = [
  { id: 'v-1', product_id: 'product-1', version: '2.0.0', status: 'supported', deprecated_at: null, sunset_at: null, release_notes: null, created_by: 'op-1', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'v-2', product_id: 'product-1', version: '1.0.0', status: 'deprecated', deprecated_at: new Date().toISOString(), sunset_at: null, release_notes: null, created_by: 'op-1', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];

// ── GET /api/v1/products/:productId/versions ──────────────────────────────────

describe('GET /api/v1/products/:productId/versions — no filter', () => {
  it('returns 200 with { data, limit, offset } envelope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: sampleVersions });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/products/product-1/versions',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[]; limit: number; offset: number }>();
      expect(body.data).toHaveLength(2);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
    } finally {
      await fastify.close();
    }
  });

  it('returns 200 with empty array when no versions exist for productId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/products/unknown-product/versions',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[] }>();
      expect(body.data).toEqual([]);
    } finally {
      await fastify.close();
    }
  });
});

describe('GET /api/v1/products/:productId/versions — with status filter', () => {
  it('returns only supported versions when ?status=supported', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleVersions[0]] });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/products/product-1/versions?status=supported',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ status: string }> }>();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe('supported');
    } finally {
      await fastify.close();
    }
  });

  it('uses a 2-column WHERE query when status filter is provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: '/api/v1/products/product-1/versions?status=deprecated',
      });
      const queryArg = mockQuery.mock.calls[0]![1] as unknown[];
      // Filtered query passes [productId, status, limit, offset]
      expect(queryArg).toHaveLength(4);
      expect(queryArg[1]).toBe('deprecated');
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for an invalid status value', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/products/product-1/versions?status=invalid',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});

describe('GET /api/v1/products/:productId/versions — pagination', () => {
  it('respects custom limit and offset', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleVersions[0]] });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/products/product-1/versions?limit=1&offset=1',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[]; limit: number; offset: number }>();
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(1);
    } finally {
      await fastify.close();
    }
  });
});
