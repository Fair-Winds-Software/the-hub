// Authorized by HUB-99 — Redis-backed rate-limit plugin: 429 shape, headers, fail-open, key strategy
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { closeRedis } from '../redis/client.js';

// Mock must be hoisted before any imports that reference the module
vi.mock('../redis/client.js', () => ({
  getRedisClient: vi.fn(),
  closeRedis: vi.fn().mockResolvedValue(undefined),
}));

import { buildApp } from '../app.js';
import { getRedisClient } from '../redis/client.js';
import { closePool } from '../db/pool.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-hub99';
  process.env.OPERATOR_JWT_SECRET ??= 'test-operator-jwt-secret-hub112';
  process.env.NODE_ENV = 'test';
});

afterEach(async () => {
  vi.clearAllMocks();
  await closePool();
  await closeRedis();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockRedis(initialCount = 0) {
  let counter = initialCount;
  return {
    incr: vi.fn().mockImplementation(async (_key: string) => {
      counter += 1;
      return counter;
    }),
    pexpire: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
    on: vi.fn().mockReturnThis(),
  };
}

function makeFailingRedis() {
  return {
    incr: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    pexpire: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
    on: vi.fn().mockReturnThis(),
  };
}

// ── AC3: 429 canonical body shape ────────────────────────────────────────────

describe('AC3 — 429 canonical body shape', () => {
  it('returns {error:{code:429,message:"Too many requests"}} when limit is exceeded', async () => {
    process.env.RATE_LIMIT_MAX = '1';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    // Start counter at 1 so the very first incr() returns 2, which exceeds max=1
    vi.mocked(getRedisClient).mockReturnValue(makeMockRedis(1) as never);

    const fastify = await buildApp();
    fastify.get('/test-rl', (_req, reply) => reply.send({ ok: true }));

    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-rl' });
      expect(res.statusCode).toBe(429);
      const body = res.json<{ error: { code: number; message: string } }>();
      expect(body.error.code).toBe(429);
      expect(body.error.message).toBe('Too many requests');
    } finally {
      delete process.env.RATE_LIMIT_MAX;
      delete process.env.RATE_LIMIT_WINDOW_MS;
      await fastify.close();
    }
  });

  it('429 response contains only {error:{code,message}} — no extra fields', async () => {
    process.env.RATE_LIMIT_MAX = '1';
    vi.mocked(getRedisClient).mockReturnValue(makeMockRedis(1) as never);

    const fastify = await buildApp();
    fastify.get('/test-rl-shape', (_req, reply) => reply.send({ ok: true }));

    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-rl-shape' });
      expect(res.statusCode).toBe(429);
      const body = res.json<Record<string, unknown>>();
      expect(Object.keys(body)).toEqual(['error']);
      const err = body.error as Record<string, unknown>;
      expect(Object.keys(err).sort()).toEqual(['code', 'message']);
    } finally {
      delete process.env.RATE_LIMIT_MAX;
      await fastify.close();
    }
  });
});

// ── AC6: Retry-After header ──────────────────────────────────────────────────

describe('AC6 — Retry-After header on 429', () => {
  it('sets retry-after header on rate-limited response', async () => {
    process.env.RATE_LIMIT_MAX = '1';
    vi.mocked(getRedisClient).mockReturnValue(makeMockRedis(1) as never);

    const fastify = await buildApp();
    fastify.get('/test-retry-after', (_req, reply) => reply.send({ ok: true }));

    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-retry-after' });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      delete process.env.RATE_LIMIT_MAX;
      await fastify.close();
    }
  });
});

// ── Functional: X-RateLimit headers on normal responses ─────────────────────

describe('X-RateLimit headers on non-limited responses', () => {
  it('sets x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset on normal response', async () => {
    process.env.RATE_LIMIT_MAX = '10';
    vi.mocked(getRedisClient).mockReturnValue(makeMockRedis(0) as never);

    const fastify = await buildApp();
    fastify.get('/test-headers', (_req, reply) => reply.send({ ok: true }));

    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-headers' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    } finally {
      delete process.env.RATE_LIMIT_MAX;
      await fastify.close();
    }
  });

  it('x-ratelimit-remaining decrements on successive requests', async () => {
    process.env.RATE_LIMIT_MAX = '5';
    const mockRedis = makeMockRedis(0);
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    const fastify = await buildApp();
    fastify.get('/test-decrement', (_req, reply) => reply.send({ ok: true }));

    try {
      const res1 = await fastify.inject({ method: 'GET', url: '/test-decrement' });
      const res2 = await fastify.inject({ method: 'GET', url: '/test-decrement' });

      const remaining1 = Number(res1.headers['x-ratelimit-remaining']);
      const remaining2 = Number(res2.headers['x-ratelimit-remaining']);

      expect(remaining1).toBeGreaterThan(remaining2);
    } finally {
      delete process.env.RATE_LIMIT_MAX;
      await fastify.close();
    }
  });
});

// ── AC8: Fail-open when Redis unavailable ────────────────────────────────────

describe('AC8 — fail-open when Redis is unavailable', () => {
  it('passes requests through (200) and logs a Pino warning when Redis errors', async () => {
    vi.mocked(getRedisClient).mockReturnValue(makeFailingRedis() as never);

    const logs: unknown[] = [];
    const { Writable } = await import('node:stream');
    const dest = new Writable({
      write(chunk, _enc, cb) {
        const line = chunk.toString();
        try {
          logs.push(JSON.parse(line));
        } catch {
          /* ignore non-JSON */
        }
        cb();
      },
    });

    const fastify = await buildApp(dest);
    fastify.get('/test-fail-open', (_req, reply) => reply.send({ ok: true }));

    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-fail-open' });
      // Request must pass through — not blocked on Redis failure
      expect(res.statusCode).toBe(200);
      // A Pino warning must have been logged
      const warnings = logs.filter(
        (l: unknown) => (l as Record<string, unknown>).level === 40,
      );
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      await fastify.close();
    }
  });
});

// ── AC2: Configurable via env vars ───────────────────────────────────────────

describe('AC2 — configurable limits via env vars', () => {
  it('uses RATE_LIMIT_MAX from env', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    // Counter starting at 3 means next incr() = 4, exceeds max=3
    vi.mocked(getRedisClient).mockReturnValue(makeMockRedis(3) as never);

    const fastify = await buildApp();
    fastify.get('/test-max', (_req, reply) => reply.send({ ok: true }));

    try {
      const res = await fastify.inject({ method: 'GET', url: '/test-max' });
      expect(res.statusCode).toBe(429);
      // Max header should reflect our configured limit
      expect(res.headers['x-ratelimit-limit']).toBe('3');
    } finally {
      delete process.env.RATE_LIMIT_MAX;
      await fastify.close();
    }
  });
});
