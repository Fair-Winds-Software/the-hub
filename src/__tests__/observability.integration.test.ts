// Authorized by HUB-1515 — observability integration tests: log schema, traceparent, redaction, /health, /ready

import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import pino from "pino";
import { Writable } from "node:stream";

// ── Mock health probes — must hoist before healthRoutes import ────────────────

vi.mock("../health/probes.js", () => ({ runHealthChecks: vi.fn() }));

import { createLogger } from "../logging/index.js";
import traceparentPlugin from "../logging/plugin.js";
import { runHealthChecks } from "../health/probes.js";
import healthRoutes from "../routes/health.js";
import type {
  ProbeResult,
  StripeProbeResult,
  HealthCheckResult,
} from "../health/probes.js";

// ── Log capture helper ────────────────────────────────────────────────────────

function createLogCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunk
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((raw) => {
          try {
            lines.push(JSON.parse(raw) as Record<string, unknown>);
          } catch {
            /* skip non-JSON */
          }
        });
      cb();
    },
  });
  return { lines, stream };
}

// ── Probe result fixtures ─────────────────────────────────────────────────────

function probe(
  status: "ok" | "error" | "timeout",
  latency_ms = 1,
): ProbeResult {
  return { status, latency_ms };
}

function stripeProbe(
  status: "ok" | "error" | "disabled",
  latency_ms = 1,
): StripeProbeResult {
  return { status, latency_ms };
}

function allOk(): HealthCheckResult {
  return {
    pg: probe("ok"),
    redis: probe("ok"),
    stripe: stripeProbe("ok"),
    queue: probe("ok"),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── §1 Log schema — createLogger() ───────────────────────────────────────────

describe("§1 log schema — createLogger()", () => {
  it("exposes all four required schema fields as null by default", () => {
    const logger = createLogger();
    const b = logger.bindings();
    expect(b).toHaveProperty("trace_id", null);
    expect(b).toHaveProperty("span_id", null);
    expect(b).toHaveProperty("tenant_id", null);
    expect(b).toHaveProperty("product_id", null);
  });

  it("seeded bindings override null defaults", () => {
    const logger = createLogger({ tenant_id: "acme", product_id: "hub" });
    const b = logger.bindings();
    expect(b.tenant_id).toBe("acme");
    expect(b.product_id).toBe("hub");
    expect(b.trace_id).toBeNull();
    expect(b.span_id).toBeNull();
  });
});

// ── §2 Traceparent — valid header ─────────────────────────────────────────────

describe("§2 traceparent — valid W3C header", () => {
  it("binds trace_id and span_id on request.log from a valid traceparent header", async () => {
    const fastify = Fastify({ logger: { level: "silent" } });
    await fastify.register(traceparentPlugin);

    // Route echoes the request.log bindings so the test can inspect them
    fastify.get("/echo", async (request) => request.log.bindings());

    const traceId = "a".repeat(32);
    const spanId = "b".repeat(16);
    const res = await fastify.inject({
      method: "GET",
      url: "/echo",
      headers: { traceparent: `00-${traceId}-${spanId}-01` },
    });

    const body = res.json<Record<string, unknown>>();
    expect(body.trace_id).toBe(traceId);
    expect(body.span_id).toBe(spanId);
    await fastify.close();
  });
});

// ── §3 Traceparent — absent or invalid header ─────────────────────────────────

describe("§3 traceparent — absent or invalid header", () => {
  async function buildEchoApp() {
    const fastify = Fastify({ logger: { level: "silent" } });
    await fastify.register(traceparentPlugin);
    fastify.get("/echo", async (request) => request.log.bindings());
    return fastify;
  }

  it("sets trace_id and span_id to null when traceparent header is absent", async () => {
    const fastify = await buildEchoApp();
    const res = await fastify.inject({ method: "GET", url: "/echo" });
    const body = res.json<Record<string, unknown>>();
    expect(body.trace_id).toBeNull();
    expect(body.span_id).toBeNull();
    await fastify.close();
  });

  it("sets trace_id and span_id to null for a malformed traceparent value", async () => {
    const fastify = await buildEchoApp();
    const res = await fastify.inject({
      method: "GET",
      url: "/echo",
      headers: { traceparent: "invalid-not-w3c" },
    });
    const body = res.json<Record<string, unknown>>();
    expect(body.trace_id).toBeNull();
    expect(body.span_id).toBeNull();
    await fastify.close();
  });
});

// ── §4 Redaction — sensitive log fields ───────────────────────────────────────

describe("§4 redaction — sensitive fields are censored", () => {
  function buildRedactLogger(stream: Writable) {
    return pino(
      {
        level: "trace",
        base: null,
        redact: {
          paths: [
            "req.headers.authorization",
            'req.headers["x-client-secret"]',
            "*.password",
            "*.secret",
            "*.token",
          ],
          censor: "[redacted]",
        },
      },
      stream,
    );
  }

  function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  it("redacts *.password one level deep", async () => {
    const { lines, stream } = createLogCapture();
    buildRedactLogger(stream).info({ user: { password: "hunter2" } }, "auth");
    await tick();
    expect(
      (lines[0] as Record<string, Record<string, unknown>>).user?.password,
    ).toBe("[redacted]");
  });

  it("redacts *.token one level deep", async () => {
    const { lines, stream } = createLogCapture();
    buildRedactLogger(stream).info({ session: { token: "abc123" } }, "session");
    await tick();
    expect(
      (lines[0] as Record<string, Record<string, unknown>>).session?.token,
    ).toBe("[redacted]");
  });

  it("redacts req.headers.authorization", async () => {
    const { lines, stream } = createLogCapture();
    buildRedactLogger(stream).info(
      { req: { headers: { authorization: "Bearer secret-jwt" } } },
      "request logged",
    );
    await tick();
    type Nested = Record<string, Record<string, Record<string, unknown>>>;
    expect((lines[0] as Nested).req?.headers?.authorization).toBe("[redacted]");
  });
});

// ── §5 GET /health ────────────────────────────────────────────────────────────

describe("§5 GET /health", () => {
  async function buildApp() {
    const fastify = Fastify({ logger: false });
    await fastify.register(healthRoutes);
    return fastify;
  }

  it('returns 200 with status "ok" when all probes are healthy', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue(allOk());
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; checks: HealthCheckResult }>();
      expect(body.status).toBe("ok");
      expect(body.checks.pg.status).toBe("ok");
      expect(body.checks.redis.status).toBe("ok");
    } finally {
      await fastify.close();
    }
  });

  it('returns 503 with status "degraded" when any probe fails', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: probe("error"),
      redis: probe("ok"),
      stripe: stripeProbe("ok"),
      queue: probe("ok"),
    });
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: HealthCheckResult }>();
      expect(body.status).toBe("degraded");
      expect(body.checks.pg.status).toBe("error");
    } finally {
      await fastify.close();
    }
  });
});

// ── §6 GET /ready ─────────────────────────────────────────────────────────────

describe("§6 GET /ready", () => {
  async function buildApp() {
    const fastify = Fastify({ logger: false });
    await fastify.register(healthRoutes);
    return fastify;
  }

  it("returns 200 when pg and redis are healthy", async () => {
    vi.mocked(runHealthChecks).mockResolvedValue(allOk());
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe("ok");
    } finally {
      await fastify.close();
    }
  });

  it('returns 503 with failing:["pg"] when pg is unhealthy', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: probe("error"),
      redis: probe("ok"),
      stripe: stripeProbe("ok"),
      queue: probe("ok"),
    });
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; failing: string[] }>();
      expect(body.failing).toContain("pg");
      expect(body.failing).not.toContain("redis");
    } finally {
      await fastify.close();
    }
  });

  it("returns 503 with both pg and redis in failing[] when both are down", async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: probe("timeout"),
      redis: probe("error"),
      stripe: stripeProbe("disabled", 0),
      queue: probe("ok"),
    });
    const fastify = await buildApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; failing: string[] }>();
      expect(body.failing).toContain("pg");
      expect(body.failing).toContain("redis");
    } finally {
      await fastify.close();
    }
  });
});
