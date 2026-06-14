// Authorized by HUB-217 — unit tests for runHealthChecks(); probe isolation; timeout; disabled stripe
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db/pool.js', () => ({ getPool: vi.fn() }));
vi.mock('../../redis/client.js', () => ({ getRedisClient: vi.fn() }));
vi.mock('../../stripe/client.js', () => ({ getStripeClient: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getPool } from '../../db/pool.js';
import { getRedisClient } from '../../redis/client.js';
import { getStripeClient } from '../../stripe/client.js';
import { runHealthChecks } from '../probes.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function setupHappyPath() {
  vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockResolvedValue({}) } as never);
  vi.mocked(getRedisClient).mockReturnValue({ ping: vi.fn().mockResolvedValue('PONG') } as never);
  vi.mocked(getStripeClient).mockReturnValue({
    balance: { retrieve: vi.fn().mockResolvedValue({}) },
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

describe('all probes succeed', () => {
  it('returns ok for all three probes', async () => {
    setupHappyPath();
    const result = await runHealthChecks();
    expect(result).toEqual({ pg: 'ok', redis: 'ok', stripe: 'ok' });
  });
});

// ── pg probe ─────────────────────────────────────────────────────────────────

describe('pg probe', () => {
  it('returns "error" when pool.query rejects', async () => {
    setupHappyPath();
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as never);
    const result = await runHealthChecks();
    expect(result.pg).toBe('error');
    // redis and stripe unaffected
    expect(result.redis).toBe('ok');
    expect(result.stripe).toBe('ok');
  });

  it('returns "timeout" when pool.query never resolves within 2000ms', async () => {
    vi.useFakeTimers();
    setupHappyPath();
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    } as never);

    const promise = runHealthChecks();
    await vi.advanceTimersByTimeAsync(2001);
    const result = await promise;

    expect(result.pg).toBe('timeout');
    expect(result.redis).toBe('ok');
    vi.useRealTimers();
  });
});

// ── Redis probe ───────────────────────────────────────────────────────────────

describe('redis probe', () => {
  it('returns "error" when redis.ping() rejects', async () => {
    setupHappyPath();
    vi.mocked(getRedisClient).mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as never);
    const result = await runHealthChecks();
    expect(result.redis).toBe('error');
    expect(result.pg).toBe('ok');
    expect(result.stripe).toBe('ok');
  });

  it('returns "timeout" when redis.ping() never resolves within 2000ms', async () => {
    vi.useFakeTimers();
    setupHappyPath();
    vi.mocked(getRedisClient).mockReturnValue({
      ping: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    } as never);

    const promise = runHealthChecks();
    await vi.advanceTimersByTimeAsync(2001);
    const result = await promise;

    expect(result.redis).toBe('timeout');
    expect(result.pg).toBe('ok');
    vi.useRealTimers();
  });
});

// ── Stripe probe ──────────────────────────────────────────────────────────────

describe('stripe probe — enabled (default)', () => {
  it('returns "error" when stripe.balance.retrieve() rejects', async () => {
    setupHappyPath();
    vi.mocked(getStripeClient).mockReturnValue({
      balance: { retrieve: vi.fn().mockRejectedValue(new Error('stripe api error')) },
    } as never);
    const result = await runHealthChecks();
    expect(result.stripe).toBe('error');
    expect(result.pg).toBe('ok');
    expect(result.redis).toBe('ok');
  });
});

describe('stripe probe — HEALTH_CHECK_STRIPE_ENABLED=false', () => {
  it('returns "disabled" and does not call the Stripe client', async () => {
    process.env.HEALTH_CHECK_STRIPE_ENABLED = 'false';
    setupHappyPath();
    const mockRetrieve = vi.fn();
    vi.mocked(getStripeClient).mockReturnValue({
      balance: { retrieve: mockRetrieve },
    } as never);

    const result = await runHealthChecks();

    expect(result.stripe).toBe('disabled');
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(result.pg).toBe('ok');
    expect(result.redis).toBe('ok');
  });
});

// ── Independent failure isolation ─────────────────────────────────────────────

describe('probe isolation', () => {
  it('a pg failure does not prevent redis or stripe from completing', async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error('pg down')),
    } as never);
    vi.mocked(getRedisClient).mockReturnValue({ ping: vi.fn().mockResolvedValue('PONG') } as never);
    vi.mocked(getStripeClient).mockReturnValue({
      balance: { retrieve: vi.fn().mockResolvedValue({}) },
    } as never);

    const result = await runHealthChecks();

    expect(result.pg).toBe('error');
    expect(result.redis).toBe('ok');
    expect(result.stripe).toBe('ok');
  });

  it('all probes can fail simultaneously without throwing', async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error('pg')),
    } as never);
    vi.mocked(getRedisClient).mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error('redis')),
    } as never);
    vi.mocked(getStripeClient).mockReturnValue({
      balance: { retrieve: vi.fn().mockRejectedValue(new Error('stripe')) },
    } as never);

    await expect(runHealthChecks()).resolves.toEqual({
      pg: 'error',
      redis: 'error',
      stripe: 'error',
    });
  });
});
