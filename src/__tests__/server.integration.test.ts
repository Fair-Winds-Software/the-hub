// Authorized by HUB-77 — Fastify server bootstrap: health routes, env validation, graceful shutdown
// Authorized by HUB-230 — GET /health updated: probe-backed response shape {status, checks}
// Authorized by HUB-1514 — update assertions to use ProbeResult {status, latency_ms} shape
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Redis } from "ioredis";
import { buildApp } from "../app.js";
import { closePool } from "../db/pool.js";
import { closeRedis } from "../redis/client.js";

// Ensure required env vars are present for tests that need a running server.
// In CI these come from the workflow env; locally from .env or these fallbacks.
let redisAvailable = false;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://hub:hub@localhost:5432/hub_dev";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.JWT_SECRET ??= "test-jwt-secret-hub77";
  process.env.OPERATOR_JWT_SECRET ??= "test-operator-jwt-secret-hub112";
  // Disable stripe probe so /health only depends on pg + Redis (no Stripe credentials in test)
  process.env.HEALTH_CHECK_STRIPE_ENABLED ??= "false";

  // Probe Redis so tests that need it can be skipped locally when it isn't running.
  // In CI the redis:7-alpine service container is always present; locally it may not be.
  try {
    const probe = new Redis(process.env.REDIS_URL, {
      connectTimeout: 1000,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    probe.on("error", () => {}); // suppress unhandled error events during probe
    await probe.connect();
    await probe.quit();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
});

afterEach(async () => {
  await closePool();
  await closeRedis();
});

// ── AC2: GET /health ─────────────────────────────────────────────────────────

describe("GET /health", () => {
  it('returns probe-backed JSON with {status, checks} shape and stripe:"disabled"', async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      // 200 when all dependencies reachable; 503 when pg/redis unavailable — both valid locally
      expect([200, 503]).toContain(res.statusCode);
      const body = res.json<{
        status: string;
        checks: Record<string, { status: string; latency_ms: number }>;
      }>();
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body.checks).toHaveProperty("pg");
      expect(body.checks).toHaveProperty("redis");
      // stripe probe disabled in test environment — always 'disabled'
      expect(body.checks.stripe?.status).toBe("disabled");
    } finally {
      await fastify.close();
    }
  });

  it('returns HTTP 200 with status:"ok" when pg and Redis are both healthy', async (ctx) => {
    // Requires both services — skipped locally when Redis isn't running; always runs in CI
    if (!redisAvailable) ctx.skip();
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        status: string;
        checks: Record<string, { status: string; latency_ms: number }>;
      }>();
      expect(body.status).toBe("ok");
      expect(body.checks.pg?.status).toBe("ok");
      expect(body.checks.redis?.status).toBe("ok");
    } finally {
      await fastify.close();
    }
  });

  it("is reachable without any auth header — not 401 or 403", async () => {
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    } finally {
      await fastify.close();
    }
  });
});

// ── AC3: GET /health/ready ───────────────────────────────────────────────────

describe("GET /health/ready", () => {
  it("returns 200 when PostgreSQL and Redis are healthy", async (ctx) => {
    // Requires both services — skipped locally when Redis isn't running; always runs in CI
    if (!redisAvailable) ctx.skip();
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe("ok");
    } finally {
      await fastify.close();
    }
  });

  it("returns 503 when PostgreSQL is unavailable", async () => {
    const saved = process.env.DATABASE_URL;
    // Port 9999 has nothing listening — connection refused immediately
    process.env.DATABASE_URL = "postgresql://hub:hub@localhost:9999/invalid";
    try {
      const fastify = await buildApp();
      try {
        const res = await fastify.inject({
          method: "GET",
          url: "/health/ready",
        });
        expect(res.statusCode).toBe(503);
      } finally {
        await fastify.close();
      }
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});

// ── AC5: missing required env vars ──────────────────────────────────────────

describe("env validation", () => {
  it("throws listing DATABASE_URL when it is missing", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(buildApp()).rejects.toThrow("DATABASE_URL");
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("throws listing REDIS_URL when it is missing", async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      await expect(buildApp()).rejects.toThrow("REDIS_URL");
    } finally {
      if (saved !== undefined) process.env.REDIS_URL = saved;
    }
  });

  it("throws listing JWT_SECRET when it is missing", async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      await expect(buildApp()).rejects.toThrow("JWT_SECRET");
    } finally {
      if (saved !== undefined) process.env.JWT_SECRET = saved;
    }
  });
});

// ── AC4: graceful shutdown ───────────────────────────────────────────────────

describe("graceful shutdown", () => {
  it("fastify.close() resolves cleanly after buildApp()", async () => {
    const fastify = await buildApp();
    await expect(fastify.close()).resolves.not.toThrow();
  });
});

// ── AC6: plugin registration ─────────────────────────────────────────────────

describe("plugin architecture", () => {
  it("buildApp() returns a Fastify instance with routes registered", async () => {
    const fastify = await buildApp();
    try {
      const routes = fastify.printRoutes();
      // Fastify 5 printRoutes() renders a tree; /health appears as 'health' under the root node
      expect(routes).toContain("health");
    } finally {
      await fastify.close();
    }
  });
});
