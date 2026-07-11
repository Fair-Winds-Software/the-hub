// Authorized by HUB-1792 (S3 of HUB-1783) — unit tests for the shared health-probe helper.
// Verifies runProbe classification (ok/degraded/down), latency measurement, timeout, and the
// getCachedStatus TTL + mode-change invalidation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The probe cache module reads mode via the registry. Mock the registry so tests can
// force mode without full setup.
const mockGetConnectionMode = vi.hoisted(() => vi.fn(() => 'live' as 'live' | 'mock'));
vi.mock('../registry.js', () => ({
  getConnectionMode: mockGetConnectionMode,
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockGetConnectionMode.mockImplementation(() => 'live');
  const { _resetStatusCacheForTest } = await import('../probe.js');
  _resetStatusCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runProbe', () => {
  it('returns ok when the probe resolves within the timeout', async () => {
    const { runProbe } = await import('../probe.js');
    const result = await runProbe('stripe', async () => {});
    expect(result.health).toBe('ok');
    expect(result.reason).toBeUndefined();
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns degraded when the probe throws a rate-limit-like error', async () => {
    const { runProbe } = await import('../probe.js');
    const result = await runProbe('stripe', async () => {
      throw new Error('rate_limit exceeded');
    });
    expect(result.health).toBe('degraded');
    expect(result.reason).toContain('rate_limit');
  });

  it('returns degraded for HTTP 429 error messages', async () => {
    const { runProbe } = await import('../probe.js');
    const result = await runProbe('stripe', async () => {
      throw new Error('HTTP 429 Too Many Requests');
    });
    expect(result.health).toBe('degraded');
  });

  it('returns degraded for GA-style RESOURCE_EXHAUSTED errors', async () => {
    const { runProbe } = await import('../probe.js');
    const result = await runProbe('ga', async () => {
      throw new Error('RESOURCE_EXHAUSTED: quota metric exceeded');
    });
    expect(result.health).toBe('degraded');
  });

  it('returns down when the probe throws a generic error', async () => {
    const { runProbe } = await import('../probe.js');
    const result = await runProbe('stripe', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(result.health).toBe('down');
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('returns down with reason=probe-timeout when the probe exceeds the timeout', async () => {
    const { runProbe } = await import('../probe.js');
    const result = await runProbe(
      'stripe',
      async () => new Promise(() => {}),
      50,
    );
    expect(result.health).toBe('down');
    expect(result.reason).toContain('timeout');
  });
});

describe('getCachedStatus', () => {
  it('returns computed status on first call and caches for TTL', async () => {
    const { getCachedStatus } = await import('../probe.js');
    const computeFn = vi.fn(async () => ({
      name: 'stripe',
      mode: 'live' as const,
      health: 'ok' as const,
      checked_at: '2026-07-11T00:00:00Z',
      latency_ms: 5,
    }));
    await getCachedStatus('stripe', computeFn);
    await getCachedStatus('stripe', computeFn);
    await getCachedStatus('stripe', computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the mode changes between calls', async () => {
    const { getCachedStatus } = await import('../probe.js');
    const computeFn = vi.fn(async () => ({
      name: 'stripe',
      mode: 'live' as const,
      health: 'ok' as const,
      checked_at: 'x',
      latency_ms: 0,
    }));
    mockGetConnectionMode.mockReturnValueOnce('live');
    await getCachedStatus('stripe', computeFn);
    mockGetConnectionMode.mockReturnValueOnce('mock');
    await getCachedStatus('stripe', computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);
  });

  it('respects the 15s TTL', async () => {
    vi.useFakeTimers();
    const { getCachedStatus } = await import('../probe.js');
    const computeFn = vi.fn(async () => ({
      name: 'stripe',
      mode: 'live' as const,
      health: 'ok' as const,
      checked_at: 'x',
      latency_ms: 0,
    }));
    await getCachedStatus('stripe', computeFn);
    vi.advanceTimersByTime(10_000);
    await getCachedStatus('stripe', computeFn);
    expect(computeFn).toHaveBeenCalledTimes(1); // still cached at 10s
    vi.advanceTimersByTime(6_000);
    await getCachedStatus('stripe', computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2); // expired past 15s
  });

  it('_resetStatusCacheForTest clears the cache for the named connection', async () => {
    const { getCachedStatus, _resetStatusCacheForTest } = await import('../probe.js');
    const computeFn = vi.fn(async () => ({
      name: 'stripe',
      mode: 'live' as const,
      health: 'ok' as const,
      checked_at: 'x',
      latency_ms: 0,
    }));
    await getCachedStatus('stripe', computeFn);
    _resetStatusCacheForTest('stripe');
    await getCachedStatus('stripe', computeFn);
    expect(computeFn).toHaveBeenCalledTimes(2);
  });
});
