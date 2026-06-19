// Authorized by HUB-230 — unit tests for deriveStatus(); integration tests for GET /health route
// Authorized by HUB-1514 — ProbeResult-aware assertions; GET /ready tests
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import type {
  HealthCheckResult,
  ProbeResult,
  StripeProbeResult,
} from "../../health/probes.js";

vi.mock("../../health/probes.js", () => ({ runHealthChecks: vi.fn() }));

import { runHealthChecks } from "../../health/probes.js";
import healthRoutes, { deriveStatus } from "../health.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function ok(latency_ms = 1): ProbeResult {
  return { status: "ok", latency_ms };
}

function stripeOk(latency_ms = 1): StripeProbeResult {
  return { status: "ok", latency_ms };
}

function stripeDisabled(): StripeProbeResult {
  return { status: "disabled", latency_ms: 0 };
}

function err(latency_ms = 1): ProbeResult {
  return { status: "error", latency_ms };
}

function stripeErr(latency_ms = 1): StripeProbeResult {
  return { status: "error", latency_ms };
}

function timeout(latency_ms = 2001): ProbeResult {
  return { status: "timeout", latency_ms };
}

function allOk(): HealthCheckResult {
  return { pg: ok(), redis: ok(), stripe: stripeOk(), queue: ok() };
}

// ── deriveStatus() unit tests ─────────────────────────────────────────────────

describe("deriveStatus()", () => {
  it('returns "ok" when all probes return "ok"', () => {
    expect(deriveStatus(allOk())).toBe("ok");
  });

  it('returns "ok" when stripe is "disabled" and pg + redis + queue are "ok"', () => {
    expect(
      deriveStatus({
        pg: ok(),
        redis: ok(),
        stripe: stripeDisabled(),
        queue: ok(),
      }),
    ).toBe("ok");
  });

  it('returns "degraded" when pg returns "error"', () => {
    expect(
      deriveStatus({ pg: err(), redis: ok(), stripe: stripeOk(), queue: ok() }),
    ).toBe("degraded");
  });

  it('returns "degraded" when redis returns "error"', () => {
    expect(
      deriveStatus({ pg: ok(), redis: err(), stripe: stripeOk(), queue: ok() }),
    ).toBe("degraded");
  });

  it('returns "degraded" when stripe returns "error"', () => {
    expect(
      deriveStatus({ pg: ok(), redis: ok(), stripe: stripeErr(), queue: ok() }),
    ).toBe("degraded");
  });

  it('returns "degraded" when queue returns "error"', () => {
    expect(
      deriveStatus({ pg: ok(), redis: ok(), stripe: stripeOk(), queue: err() }),
    ).toBe("degraded");
  });

  it('returns "degraded" when any probe returns "timeout"', () => {
    expect(
      deriveStatus({
        pg: timeout(),
        redis: ok(),
        stripe: stripeOk(),
        queue: ok(),
      }),
    ).toBe("degraded");
    expect(
      deriveStatus({
        pg: ok(),
        redis: timeout(),
        stripe: stripeOk(),
        queue: ok(),
      }),
    ).toBe("degraded");
  });

  it('returns "degraded" when pg errors even with stripe "disabled"', () => {
    expect(
      deriveStatus({
        pg: err(),
        redis: ok(),
        stripe: stripeDisabled(),
        queue: ok(),
      }),
    ).toBe("degraded");
  });
});

// ── GET /health route integration ─────────────────────────────────────────────

async function buildTestApp() {
  const fastify = Fastify({ logger: false });
  await fastify.register(healthRoutes);
  return fastify;
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── All probes succeed ────────────────────────────────────────────────────────

describe("GET /health — all probes ok", () => {
  it('returns HTTP 200 with {status:"ok", checks:{pg,redis,stripe,queue}}', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue(allOk());
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; checks: HealthCheckResult }>();
      expect(body.status).toBe("ok");
      expect(body.checks.pg.status).toBe("ok");
      expect(body.checks.redis.status).toBe("ok");
      expect(body.checks.stripe.status).toBe("ok");
      expect(body.checks.queue.status).toBe("ok");
    } finally {
      await fastify.close();
    }
  });

  it("is reachable with no auth headers — not 401 or 403", async () => {
    vi.mocked(runHealthChecks).mockResolvedValue(allOk());
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    } finally {
      await fastify.close();
    }
  });
});

// ── Probe failures ────────────────────────────────────────────────────────────

describe("GET /health — probe failure", () => {
  it('returns HTTP 503 with status:"degraded" when pg is "error"', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: err(),
      redis: ok(),
      stripe: stripeOk(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: HealthCheckResult }>();
      expect(body.status).toBe("degraded");
      expect(body.checks.pg.status).toBe("error");
      expect(body.checks.redis.status).toBe("ok");
      expect(body.checks.stripe.status).toBe("ok");
    } finally {
      await fastify.close();
    }
  });

  it('preserves "timeout" as-is in the body — not remapped to "error"', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: ok(),
      redis: timeout(),
      stripe: stripeOk(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: HealthCheckResult }>();
      expect(body.status).toBe("degraded");
      expect(body.checks.redis.status).toBe("timeout");
    } finally {
      await fastify.close();
    }
  });

  it("all check results (pg, redis, stripe, queue) are always present in the body", async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: err(),
      redis: ok(),
      stripe: stripeOk(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      const body = res.json<{ status: string; checks: HealthCheckResult }>();
      expect(body.checks).toHaveProperty("pg");
      expect(body.checks).toHaveProperty("redis");
      expect(body.checks).toHaveProperty("stripe");
      expect(body.checks).toHaveProperty("queue");
    } finally {
      await fastify.close();
    }
  });
});

// ── Stripe disabled ───────────────────────────────────────────────────────────

describe("GET /health — stripe disabled", () => {
  it('returns HTTP 200 when stripe is "disabled" and pg+redis+queue are "ok"', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: ok(),
      redis: ok(),
      stripe: stripeDisabled(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; checks: HealthCheckResult }>();
      expect(body.status).toBe("ok");
      expect(body.checks.stripe.status).toBe("disabled");
    } finally {
      await fastify.close();
    }
  });

  it('"disabled" alone does not trigger 503 — pg+redis determine overall status', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: err(),
      redis: ok(),
      stripe: stripeDisabled(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: HealthCheckResult }>();
      expect(body.status).toBe("degraded");
      expect(body.checks.stripe.status).toBe("disabled");
    } finally {
      await fastify.close();
    }
  });
});

// ── GET /ready ────────────────────────────────────────────────────────────────

describe("GET /ready — critical probes healthy", () => {
  it('returns HTTP 200 with {status:"ok"} when pg and redis are healthy', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue(allOk());
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string }>();
      expect(body.status).toBe("ok");
    } finally {
      await fastify.close();
    }
  });

  it('returns HTTP 200 even when stripe is "disabled" and queue is non-critical', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: ok(),
      redis: ok(),
      stripe: stripeDisabled(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(200);
    } finally {
      await fastify.close();
    }
  });
});

describe("GET /ready — critical probe failure", () => {
  it('returns HTTP 503 with failing:["pg"] when pg is down', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: err(),
      redis: ok(),
      stripe: stripeOk(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; failing: string[] }>();
      expect(body.status).toBe("degraded");
      expect(body.failing).toContain("pg");
      expect(body.failing).not.toContain("redis");
    } finally {
      await fastify.close();
    }
  });

  it('returns HTTP 503 with failing:["redis"] when redis is down', async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: ok(),
      redis: err(),
      stripe: stripeOk(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; failing: string[] }>();
      expect(body.status).toBe("degraded");
      expect(body.failing).toContain("redis");
      expect(body.failing).not.toContain("pg");
    } finally {
      await fastify.close();
    }
  });

  it("returns HTTP 503 with both pg and redis in failing[] when both are down", async () => {
    vi.mocked(runHealthChecks).mockResolvedValue({
      pg: err(),
      redis: timeout(),
      stripe: stripeOk(),
      queue: ok(),
    });
    const fastify = await buildTestApp();
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

  it("is reachable with no auth headers — not 401 or 403", async () => {
    vi.mocked(runHealthChecks).mockResolvedValue(allOk());
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    } finally {
      await fastify.close();
    }
  });
});
