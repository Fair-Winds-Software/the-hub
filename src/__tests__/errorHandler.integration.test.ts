// Authorized by HUB-79 — Global error handler: AppError, sanitized 500, 404, schema validation, stack-trace absence
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { buildApp } from '../app.js';
import { AppError } from '../errors/AppError.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../redis/client.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-hub79';
  process.env.NODE_ENV = 'test';
});

afterEach(async () => {
  await closePool();
  await closeRedis();
});

// ── AC1: AppError passthrough ────────────────────────────────────────────────

describe('AC1 — AppError passthrough', () => {
  it('AppError(403, "Forbidden") → 403 with canonical body', async () => {
    const fastify = await buildApp();
    fastify.get('/test-app-error', () => {
      throw new AppError(403, 'Forbidden');
    });
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-app-error' });
      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(403);
      expect(body.error.message).toBe('Forbidden');
    } finally {
      await fastify.close();
    }
  });

  it('AppError(422, "Unprocessable") → 422 with canonical body', async () => {
    const fastify = await buildApp();
    fastify.get('/test-422', () => {
      throw new AppError(422, 'Unprocessable');
    });
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-422' });
      expect(res.statusCode).toBe(422);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(422);
      expect(body.error.message).toBe('Unprocessable');
    } finally {
      await fastify.close();
    }
  });
});

// ── AC2: Unexpected errors → sanitized 500 ───────────────────────────────────

describe('AC2 — unexpected error sanitization', () => {
  it('unhandled Error → 500 with generic message; original message absent', async () => {
    const fastify = await buildApp();
    fastify.get('/test-unhandled', () => {
      throw new Error('db connection failed: password authentication failed');
    });
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-unhandled' });
      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(500);
      expect(body.error.message).toBe('Internal server error');
      // Original error message must not leak
      expect(res.body).not.toContain('db connection failed');
      expect(res.body).not.toContain('password authentication failed');
    } finally {
      await fastify.close();
    }
  });
});

// ── AC3: Stack traces absent from all response bodies ────────────────────────

describe('AC3 — stack traces absent from responses', () => {
  it('AppError response contains no stack trace', async () => {
    const fastify = await buildApp();
    fastify.get('/test-stack-apperror', () => {
      throw new AppError(400, 'Bad request');
    });
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-stack-apperror' });
      expect(res.body).not.toContain('at ');
      expect(res.body).not.toContain('.ts:');
      expect(res.body).not.toContain('stack');
    } finally {
      await fastify.close();
    }
  });

  it('unhandled Error response contains no stack trace', async () => {
    const fastify = await buildApp();
    fastify.get('/test-stack-unexpected', () => {
      throw new Error('internal failure');
    });
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-stack-unexpected' });
      expect(res.body).not.toContain('at ');
      expect(res.body).not.toContain('.ts:');
      expect(res.body).not.toContain('stack');
    } finally {
      await fastify.close();
    }
  });
});

// ── AC5: Unmapped routes → 404 canonical format ──────────────────────────────

describe('AC5 — 404 not found handler', () => {
  it('GET /unmapped-route-xyz → 404 with canonical body', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/unmapped-route-xyz' });
      expect(res.statusCode).toBe(404);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(404);
      expect(body.error.message).toBe('Route not found');
    } finally {
      await fastify.close();
    }
  });

  it('POST /also-not-a-route → 404 with canonical body', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: 'POST', url: '/also-not-a-route' });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: number; message: string } }>().error.code).toBe(404);
    } finally {
      await fastify.close();
    }
  });
});

// ── AC6: Schema validation errors → 400 canonical format ─────────────────────

describe('AC6 — schema validation errors', () => {
  it('missing required body field → 400 with Validation error prefix', async () => {
    const fastify = await buildApp();
    fastify.post('/test-schema', {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
          additionalProperties: false,
        },
      },
    }, (_request, reply) => reply.send({ ok: true }));

    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/test-schema',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wrong: 'field' }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(400);
      expect(body.error.message).toMatch(/^Validation error:/);
    } finally {
      await fastify.close();
    }
  });

  it('wrong type for body field → 400 with Validation error prefix', async () => {
    const fastify = await buildApp();
    fastify.post('/test-schema-type', {
      schema: {
        body: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'integer' } },
        },
      },
    }, (_request, reply) => reply.send({ ok: true }));

    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/test-schema-type',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: 'not-a-number' }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(400);
      expect(body.error.message).toMatch(/^Validation error:/);
    } finally {
      await fastify.close();
    }
  });
});

// ── Canonical shape invariant ─────────────────────────────────────────────────

describe('canonical response shape', () => {
  it('error responses only contain {error:{code,message}} — no extra fields', async () => {
    const fastify = await buildApp();
    fastify.get('/test-shape', () => {
      throw new AppError(409, 'Conflict');
    });
    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-shape' });
      const body = res.json<Record<string, unknown>>();
      expect(Object.keys(body)).toEqual(['error']);
      const err = body.error as Record<string, unknown>;
      expect(Object.keys(err).sort()).toEqual(['code', 'message']);
    } finally {
      await fastify.close();
    }
  });
});
