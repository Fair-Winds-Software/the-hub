// Authorized by HUB-99 — Redis-backed rate-limit plugin; slot 3 in app.ts plugin chain
// Authorized by HUB-1551 — per-test-suite isolation. In NODE_ENV=test the
//   Redis SafeStore is swapped for the plugin's default in-memory store so
//   every buildApp() invocation gets a fresh counter. Fixes the ~110-test
//   429 cascade that was previously misdiagnosed as a bcrypt-login 401 issue.
//   The plugin STILL RUNS in test mode (still enforces limits, still returns
//   429) — only the STORE changes. A dedicated integration test in this
//   plugin's __tests__ dir proves the enforcement is exercised.
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, RouteOptions } from 'fastify';
import type { Redis } from 'ioredis';
import { getRedisClient } from '../redis/client.js';
import { AppError } from '../errors/AppError.js';

// Mirrors FastifyRateLimitStore / FastifyRateLimitStoreCtor from @fastify/rate-limit
// without importing the ambiguous namespace export directly.
interface RLStore {
  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow: number,
    max: number,
  ): void;
  child(routeOptions: RouteOptions & { path: string; prefix: string }): RLStore;
}

interface RLStoreCtor {
  new (options?: object): RLStore;
}

// Returns a constructor so @fastify/rate-limit can call `new StoreCtor(options)` per-route.
// redis and fastify are captured via closure; each child() call shares the same connection.
function makeSafeStoreCtor(redis: Redis, fastify: FastifyInstance): RLStoreCtor {
  return class SafeStore implements RLStore {
    constructor(_options?: object) {}

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
      _max: number,
    ): void {
      redis
        .incr(key)
        .then((count) => {
          if (count === 1) {
            // First hit — set TTL so the window expires correctly
            return redis.pexpire(key, timeWindow).then(() => count);
          }
          return count;
        })
        .then((count) => callback(null, { current: count, ttl: timeWindow }))
        .catch((err: Error) => {
          // Redis unavailable — log warning and signal error so skipOnError passes the request
          fastify.log.warn({ err }, 'Redis rate-limit store error — failing open');
          callback(err);
        });
    }

    child(_routeOptions: RouteOptions & { path: string; prefix: string }): RLStore {
      return new SafeStore();
    }
  };
}

const rateLimitPlugin: FastifyPluginAsync = async (fastify) => {
  const isTest = process.env.NODE_ENV === 'test';

  const baseOptions = {
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    skipOnError: true,
    keyGenerator: (request: FastifyRequest) => {
      // After HUB-98 (service auth), request may carry tenant_id; fall back to IP otherwise
      const tenantId = (request as FastifyRequest & { tenant_id?: string }).tenant_id;
      return tenantId ? `rl:${tenantId}` : `rl:ip:${request.ip}`;
    },
    // @fastify/rate-limit throws the errorResponseBuilder return value as an error.
    // Returning an AppError routes it through setErrorHandler (HUB-79), which produces
    // the canonical {error:{code,message}} shape and the correct 429 status.
    errorResponseBuilder: () => new AppError(429, 'Too many requests'),
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
  };

  if (isTest) {
    // HUB-1551: plugin's default in-memory store is per-plugin-instance.
    // Every buildApp() call gets a fresh counter → no cross-test cascade.
    await fastify.register(rateLimit, baseOptions);
    return;
  }

  const redis = getRedisClient();
  await fastify.register(rateLimit, {
    ...baseOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: makeSafeStoreCtor(redis, fastify) as any,
  });
};

export default fp(rateLimitPlugin);
