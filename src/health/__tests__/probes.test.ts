// Authorized by HUB-217 — unit tests for runHealthChecks(); probe isolation; timeout; disabled stripe
// Authorized by HUB-1514 — ProbeResult assertions; queue probe tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../db/pool.js", () => ({ getPool: vi.fn() }));
vi.mock("../../redis/client.js", () => ({ getRedisClient: vi.fn() }));
vi.mock("../../stripe/client.js", () => ({ getStripeClient: vi.fn() }));
vi.mock("../../queues/index.js", () => ({ getDlqQueue: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getPool } from "../../db/pool.js";
import { getRedisClient } from "../../redis/client.js";
import { getStripeClient } from "../../stripe/client.js";
import { getDlqQueue } from "../../queues/index.js";
import { runHealthChecks } from "../probes.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function setupHappyPath() {
  vi.mocked(getPool).mockReturnValue({
    query: vi.fn().mockResolvedValue({}),
  } as never);
  vi.mocked(getRedisClient).mockReturnValue({
    ping: vi.fn().mockResolvedValue("PONG"),
  } as never);
  vi.mocked(getStripeClient).mockReturnValue({
    balance: { retrieve: vi.fn().mockResolvedValue({}) },
  } as never);
  vi.mocked(getDlqQueue).mockReturnValue({
    getJobCounts: vi.fn().mockResolvedValue({}),
  } as never);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  delete process.env.HEALTH_CHECK_STRIPE_ENABLED;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.HEALTH_CHECK_STRIPE_ENABLED;
});

// ── All probes succeed ────────────────────────────────────────────────────────

describe("all probes succeed", () => {
  it('returns ProbeResult objects with status "ok" for all four probes', async () => {
    setupHappyPath();
    const result = await runHealthChecks();
    expect(result.pg.status).toBe("ok");
    expect(result.redis.status).toBe("ok");
    expect(result.stripe.status).toBe("ok");
    expect(result.queue.status).toBe("ok");
  });

  it("includes non-negative latency_ms for all probes", async () => {
    setupHappyPath();
    const result = await runHealthChecks();
    expect(result.pg.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.redis.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.stripe.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.queue.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

// ── pg probe ─────────────────────────────────────────────────────────────────

describe("pg probe", () => {
  it('returns status "error" when pool.query rejects', async () => {
    setupHappyPath();
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never);
    const result = await runHealthChecks();
    expect(result.pg.status).toBe("error");
    expect(result.redis.status).toBe("ok");
    expect(result.stripe.status).toBe("ok");
  });

  it('returns status "timeout" when pool.query never resolves within 2000ms', async () => {
    vi.useFakeTimers();
    setupHappyPath();
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    } as never);

    const promise = runHealthChecks();
    await vi.advanceTimersByTimeAsync(2001);
    const result = await promise;

    expect(result.pg.status).toBe("timeout");
    expect(result.redis.status).toBe("ok");
    vi.useRealTimers();
  });
});

// ── Redis probe ───────────────────────────────────────────────────────────────

describe("redis probe", () => {
  it('returns status "error" when redis.ping() rejects', async () => {
    setupHappyPath();
    vi.mocked(getRedisClient).mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    } as never);
    const result = await runHealthChecks();
    expect(result.redis.status).toBe("error");
    expect(result.pg.status).toBe("ok");
    expect(result.stripe.status).toBe("ok");
  });

  it('returns status "timeout" when redis.ping() never resolves within 2000ms', async () => {
    vi.useFakeTimers();
    setupHappyPath();
    vi.mocked(getRedisClient).mockReturnValue({
      ping: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    } as never);

    const promise = runHealthChecks();
    await vi.advanceTimersByTimeAsync(2001);
    const result = await promise;

    expect(result.redis.status).toBe("timeout");
    expect(result.pg.status).toBe("ok");
    vi.useRealTimers();
  });
});

// ── Stripe probe ──────────────────────────────────────────────────────────────

describe("stripe probe — enabled (default)", () => {
  it('returns status "error" when stripe.balance.retrieve() rejects', async () => {
    setupHappyPath();
    vi.mocked(getStripeClient).mockReturnValue({
      balance: {
        retrieve: vi.fn().mockRejectedValue(new Error("stripe api error")),
      },
    } as never);
    const result = await runHealthChecks();
    expect(result.stripe.status).toBe("error");
    expect(result.pg.status).toBe("ok");
    expect(result.redis.status).toBe("ok");
  });
});

describe("stripe probe — HEALTH_CHECK_STRIPE_ENABLED=false", () => {
  it('returns status "disabled" and does not call the Stripe client', async () => {
    process.env.HEALTH_CHECK_STRIPE_ENABLED = "false";
    setupHappyPath();
    const mockRetrieve = vi.fn();
    vi.mocked(getStripeClient).mockReturnValue({
      balance: { retrieve: mockRetrieve },
    } as never);

    const result = await runHealthChecks();

    expect(result.stripe.status).toBe("disabled");
    expect(result.stripe.latency_ms).toBe(0);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(result.pg.status).toBe("ok");
    expect(result.redis.status).toBe("ok");
  });
});

// ── Queue probe ───────────────────────────────────────────────────────────────

describe("queue probe", () => {
  it('returns status "ok" when getDlqQueue().getJobCounts() resolves', async () => {
    setupHappyPath();
    const result = await runHealthChecks();
    expect(result.queue.status).toBe("ok");
  });

  it('returns status "error" when getDlqQueue().getJobCounts() rejects', async () => {
    setupHappyPath();
    vi.mocked(getDlqQueue).mockReturnValue({
      getJobCounts: vi.fn().mockRejectedValue(new Error("redis disconnected")),
    } as never);
    const result = await runHealthChecks();
    expect(result.queue.status).toBe("error");
    expect(result.pg.status).toBe("ok");
    expect(result.redis.status).toBe("ok");
  });
});

// ── Independent failure isolation ─────────────────────────────────────────────

describe("probe isolation", () => {
  it("a pg failure does not prevent redis, stripe, or queue from completing", async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error("pg down")),
    } as never);
    vi.mocked(getRedisClient).mockReturnValue({
      ping: vi.fn().mockResolvedValue("PONG"),
    } as never);
    vi.mocked(getStripeClient).mockReturnValue({
      balance: { retrieve: vi.fn().mockResolvedValue({}) },
    } as never);
    vi.mocked(getDlqQueue).mockReturnValue({
      getJobCounts: vi.fn().mockResolvedValue({}),
    } as never);

    const result = await runHealthChecks();

    expect(result.pg.status).toBe("error");
    expect(result.redis.status).toBe("ok");
    expect(result.stripe.status).toBe("ok");
    expect(result.queue.status).toBe("ok");
  });

  it("all probes can fail simultaneously without throwing", async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error("pg")),
    } as never);
    vi.mocked(getRedisClient).mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error("redis")),
    } as never);
    vi.mocked(getStripeClient).mockReturnValue({
      balance: { retrieve: vi.fn().mockRejectedValue(new Error("stripe")) },
    } as never);
    vi.mocked(getDlqQueue).mockReturnValue({
      getJobCounts: vi.fn().mockRejectedValue(new Error("queue")),
    } as never);

    const result = await runHealthChecks();

    expect(result.pg.status).toBe("error");
    expect(result.redis.status).toBe("error");
    expect(result.stripe.status).toBe("error");
    expect(result.queue.status).toBe("error");
  });
});
