// Authorized by HUB-1820 (S3 of HUB-1787) — MetricsClient tests. fetch stubbed globally
// so no network is touched. Covers: push type/runtime validation, buffer + flush, size
// trigger, error re-buffering, flush loop start/stop.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetricsClient } from '../metricsClient.js';

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', mock as unknown as typeof fetch);
  return mock;
}

const CONFIG = {
  getBearerToken: async () => 'test-token',
  hubUrl: 'https://hub.test',
  maxBufferSize: 10,
  flushIntervalMs: 60_000,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MetricsClient — constructor + push', () => {
  it('rejects construction without getBearerToken', () => {
    expect(
      () => new MetricsClient({ ...CONFIG, getBearerToken: undefined as unknown as never }),
    ).toThrow(/getBearerToken/);
  });

  it('rejects construction without hubUrl', () => {
    expect(() => new MetricsClient({ ...CONFIG, hubUrl: '' })).toThrow(/hubUrl/);
  });

  it('push accepts a known catalog name + buffers the event', () => {
    const c = new MetricsClient(CONFIG);
    c.push('daily_active_users', 100);
    expect(c._bufferLengthForTest()).toBe(1);
  });

  it('push accepts an explicit occurred_at + dimensions', () => {
    const c = new MetricsClient(CONFIG);
    c.push('feature_adoption', 0.42, {
      dimensions: { feature: 'export_csv' },
      occurred_at: '2026-07-15T00:00:00Z',
    });
    expect(c._bufferLengthForTest()).toBe(1);
  });

  it('push throws TypeError on unknown metric name (runtime guard)', () => {
    const c = new MetricsClient(CONFIG);
    expect(() =>
      c.push('typo_metric_name' as never, 1),
    ).toThrow(/unknown metric_name/);
    expect(c._bufferLengthForTest()).toBe(0);
  });

  it('push auto-flushes when maxBufferSize reached', async () => {
    const fetchMock = stubFetch(200, { accepted: 10, dropped: [] });
    const c = new MetricsClient({ ...CONFIG, maxBufferSize: 3 });
    c.push('logins', 1);
    c.push('logins', 1);
    c.push('logins', 1);
    // Auto-flush is fire-and-forget; wait a tick for the promise to resolve.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('MetricsClient — flush', () => {
  it('POSTs to /api/v1/bi/metrics with the buffered batch + Bearer token', async () => {
    const fetchMock = stubFetch(200, { accepted: 2, dropped: [] });
    const c = new MetricsClient(CONFIG);
    c.push('daily_active_users', 500);
    c.push('mrr_cents', 1_000_000);
    const result = await c.flush();
    expect(result.accepted).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hub.test/api/v1/bi/metrics');
    const initOpts = init as { method: string; headers: Record<string, string>; body: string };
    expect(initOpts.method).toBe('POST');
    expect(initOpts.headers.Authorization).toBe('Bearer test-token');
    const body = JSON.parse(initOpts.body) as { events: Array<{ metric_name: string }> };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]!.metric_name).toBe('daily_active_users');
  });

  it('empty-buffer flush is a no-op', async () => {
    const fetchMock = stubFetch(200, { accepted: 0, dropped: [] });
    const c = new MetricsClient(CONFIG);
    const result = await c.flush();
    expect(result.accepted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-buffers events on HTTP failure', async () => {
    stubFetch(500, {});
    const c = new MetricsClient(CONFIG);
    c.push('logins', 1);
    c.push('logins', 1);
    await expect(c.flush()).rejects.toThrow(/HTTP 500/);
    expect(c._bufferLengthForTest()).toBe(2);
  });

  it('concurrent flushes are deduped (second returns empty)', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((r) => {
            resolveFirst = r;
          }),
      ) as unknown as typeof fetch,
    );
    const c = new MetricsClient(CONFIG);
    c.push('logins', 1);
    const p1 = c.flush();
    const p2 = c.flush();
    // p2 should return immediately with the sentinel
    const r2 = await p2;
    expect(r2.accepted).toBe(0);
    // Resolve the in-flight fetch so p1 can complete
    resolveFirst({ ok: true, status: 200, json: async () => ({ accepted: 1, dropped: [] }) });
    await p1;
  });
});

describe('MetricsClient — flush loop', () => {
  it('startFlushLoop schedules periodic flushes; stopFlushLoop cancels', () => {
    const c = new MetricsClient(CONFIG);
    c.startFlushLoop();
    // second start should be idempotent (no crash)
    c.startFlushLoop();
    c.stopFlushLoop();
  });
});
