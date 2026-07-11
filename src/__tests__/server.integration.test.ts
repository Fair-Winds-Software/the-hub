// Authorized by HUB-77 — Fastify server bootstrap: health routes, env validation, graceful shutdown
// Authorized by HUB-230 — GET /health updated: probe-backed response shape {status, checks}
// Authorized by HUB-1514 — update assertions to use ProbeResult {status, latency_ms} shape
// Authorized by HUB-1526 (FVL-E35) — pg→db rename in assertions per FR-35-03
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
  // HUB-1525 — new required env vars; HUB-4.1 L2 — M2/M5/L1: hex key + new required vars
  process.env.LEASE_ENCRYPTION_KEY ??= "00".repeat(32); // 64 hex chars = valid AES-256 key
  process.env.STRIPE_SECRET_KEY ??= "sk_test_hub_integration_test_key";
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET ??= "whsec_test_integration_fallback";
  process.env.HOOK_ENCRYPTION_KEY ??= "00".repeat(32); // 64 hex chars = valid AES-256 key
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
      expect(body.checks).toHaveProperty("db");
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
      // HUB-1773 close-out: warm every dependency /health probes before hitting the
      // endpoint. Probes in src/health/probes.ts use a 500ms per-probe timeout.
      // `afterEach` closes all clients, so every test starts cold; the first TCP
      // handshake + auth on any of them can exceed 500ms on a Windows dev box, races
      // to 'degraded', and /health returns 503. BullMQ opens its OWN Redis socket
      // via getRedisClientForBullMQ() — warming getRedisClient() alone is not enough,
      // so we invoke DLQ.getJobCounts() which is exactly what the queue probe calls.
      const { getPool } = await import("../db/pool.js");
      const { getRedisClient } = await import("../redis/client.js");
      const { getDlqQueue, _resetQueueInstancesForTest } = await import("../queues/index.js");
      // Clear cached Queue instances first — afterEach's closeRedis() invalidated
      // whichever ones the previous test built, and reusing them throws
      // "Connection is closed" on the first command.
      _resetQueueInstancesForTest();
      await Promise.all([
        getPool().query("SELECT 1"),
        getRedisClient().ping(),
        getDlqQueue().getJobCounts(),
      ]);

      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        status: string;
        checks: Record<string, { status: string; latency_ms: number }>;
      }>();
      expect(body.status).toBe("ok");
      expect(body.checks.db?.status).toBe("ok");
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
      // See sibling /health test above for rationale — warm pg + Redis + queue Redis
      // before probing so cold TCP handshake doesn't race the 500ms probe timeout.
      const { getPool } = await import("../db/pool.js");
      const { getRedisClient } = await import("../redis/client.js");
      const { getDlqQueue, _resetQueueInstancesForTest } = await import("../queues/index.js");
      // Clear cached Queue instances first — afterEach's closeRedis() invalidated
      // whichever ones the previous test built, and reusing them throws
      // "Connection is closed" on the first command.
      _resetQueueInstancesForTest();
      await Promise.all([
        getPool().query("SELECT 1"),
        getRedisClient().ping(),
        getDlqQueue().getJobCounts(),
      ]);

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

  it("throws listing LEASE_ENCRYPTION_KEY when it is missing", async () => {
    const saved = process.env.LEASE_ENCRYPTION_KEY;
    delete process.env.LEASE_ENCRYPTION_KEY;
    try {
      await expect(buildApp()).rejects.toThrow("LEASE_ENCRYPTION_KEY");
    } finally {
      if (saved !== undefined) process.env.LEASE_ENCRYPTION_KEY = saved;
    }
  });

  it("throws when LEASE_ENCRYPTION_KEY is not a valid 64-char hex string", async () => {
    const saved = process.env.LEASE_ENCRYPTION_KEY;
    process.env.LEASE_ENCRYPTION_KEY = "short";
    try {
      await expect(buildApp()).rejects.toThrow("LEASE_ENCRYPTION_KEY must be exactly 64 hex characters");
    } finally {
      if (saved !== undefined) process.env.LEASE_ENCRYPTION_KEY = saved;
      else delete process.env.LEASE_ENCRYPTION_KEY;
    }
  });

  it("throws listing STRIPE_SECRET_KEY when it is missing", async () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await expect(buildApp()).rejects.toThrow("STRIPE_SECRET_KEY");
    } finally {
      if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved;
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
