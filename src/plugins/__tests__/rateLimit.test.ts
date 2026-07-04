// Authorized by HUB-1551 — assertive integration test that the rate-limit
// plugin still fires 429 after the test-isolation store swap. Without
// this test, a future edit could accidentally disable the plugin under
// NODE_ENV=test and no assertion would catch it — exactly the pattern
// the story rejects ("No NODE_ENV=test disable-shortcut introduced").
//
// The test builds a minimal Fastify app that registers only the rate-
// limit plugin + a single test route, then fires (max + 5) requests and
// asserts that at least 5 come back 429. In test mode the plugin uses
// the in-memory store, so the counter is scoped to this instance and
// doesn't affect any other test's budget.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import rateLimitPlugin from '../rateLimit.js';

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Same canonical error handler shape as buildApp() so 429 emits the
  // standard body — this exercises the errorResponseBuilder → AppError
  // → setErrorHandler chain the real app depends on.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.statusCode, message: err.message } });
    }
    return reply.status(500).send({ error: { code: 500, message: 'internal' } });
  });
  await app.register(rateLimitPlugin);
  app.get('/rate-limit-target', async () => ({ ok: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  // Force a low ceiling for the assertion — the default 100 works too
  // but 5 keeps the test fast + deterministic.
  process.env.RATE_LIMIT_MAX = '5';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  app = await makeApp();
});

afterEach(async () => {
  await app.close();
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
});

describe('rateLimit plugin (HUB-1551)', () => {
  it('returns 429 after exceeding the per-instance budget', async () => {
    const max = 5;
    const overshoot = 5;
    const total = max + overshoot;
    const responses = await Promise.all(
      Array.from({ length: total }, () =>
        app.inject({ method: 'GET', url: '/rate-limit-target' }),
      ),
    );
    const tooMany = responses.filter((r) => r.statusCode === 429);
    // At least `overshoot` responses must be 429 — the first `max`
    // succeed, everything after that trips the limit.
    expect(tooMany.length).toBeGreaterThanOrEqual(overshoot);
    // The 429 body must be the canonical error shape from AppError so
    // downstream consumers can rely on the contract.
    expect(tooMany[0]!.json()).toEqual({
      error: { code: 429, message: 'Too many requests' },
    });
  });

  it('per-app-instance isolation: a second buildApp starts with a fresh budget', async () => {
    // Exhaust the first app's budget completely.
    for (let i = 0; i < 10; i += 1) {
      await app.inject({ method: 'GET', url: '/rate-limit-target' });
    }
    // Second app: fresh counter → first request should be 200, not 429.
    // This is the core of the HUB-1551 fix — before this landed, both
    // apps shared the Redis counter and the second would 429 immediately.
    const app2 = await makeApp();
    try {
      const res = await app2.inject({
        method: 'GET',
        url: '/rate-limit-target',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app2.close();
    }
  });

  it('surfaces x-ratelimit headers on successful requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/rate-limit-target',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});
