// Authorized by HUB-1006 — unit tests: buffer rollback on failure; #flushing guard; recovery cycle; TODO-D-DEF-004

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAcquireToken = vi.hoisted(() => vi.fn());
vi.mock('../auth/acquireToken.js', () => ({ acquireToken: mockAcquireToken }));

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

import { HubClient } from '../HubClient.js';

const CONFIG = {
  clientId: 'cid',
  clientSecret: 'csec',
  hubUrl: 'https://hub.example.com',
  timeoutMs: 5000,
  maxBufferSize: 100,
  flushIntervalMs: 10_000,
  lateThresholdMs: 60_000,
  disconnectFlushTimeoutMs: 1_000,
  versionReportIntervalMs: 3_600_000,
};

async function drainMicrotasks(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockAcquireToken.mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 3_600_000 });
  // Default: OK response
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

// ── network error rollback ─────────────────────────────────────────────────────

describe('buffer retention — network error rollback', () => {
  it('prepends batch back to buffer in original order on network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HubClient(CONFIG);
    await client.connect();

    // Queue: version report already consumed; next call throws network error
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    client.trackUsage('t1', 'p1', { event_type: 'a', quantity: 1 });
    client.trackUsage('t1', 'p1', { event_type: 'b', quantity: 2 });

    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    // Events should still be in buffer after rollback
    // Verify by confirming a second flush attempt sends them
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    const ingestCalls = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    expect(ingestCalls.length).toBeGreaterThanOrEqual(2); // failed + recovered

    // Second ingest should have both events in original order
    const recoveryBody = JSON.parse(
      (ingestCalls.at(-1)![1] as RequestInit).body as string,
    ) as { events: Array<{ event_type: string }> };
    expect(recoveryBody.events[0]!.event_type).toBe('a');
    expect(recoveryBody.events[1]!.event_type).toBe('b');

    warnSpy.mockRestore();
  });

  it('emits console.warn on network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockRejectedValueOnce(new Error('Network failure'));
    client.trackUsage('t1', 'p1', { event_type: 'x', quantity: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      'Usage flush failed; events retained',
      expect.objectContaining({ err: expect.any(Error) }),
    );
    warnSpy.mockRestore();
  });
});

// ── HTTP error rollback ────────────────────────────────────────────────────────

describe('buffer retention — HTTP error rollback', () => {
  it('prepends batch back on non-2xx HTTP response', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HubClient(CONFIG);
    await client.connect();

    // First ingest returns 503
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

    client.trackUsage('t1', 'p1', { event_type: 'x', quantity: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    // Recovery flush
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    const ingestCalls = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    expect(ingestCalls.length).toBeGreaterThanOrEqual(2);

    // Events present in recovery batch
    const recoveryBody = JSON.parse(
      (ingestCalls.at(-1)![1] as RequestInit).body as string,
    ) as { events: Array<{ event_type: string }> };
    expect(recoveryBody.events[0]!.event_type).toBe('x');

    warnSpy.mockRestore();
  });

  it('emits console.warn with status on HTTP error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    client.trackUsage('t1', 'p1', { event_type: 'x', quantity: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      'Usage flush failed; events retained',
      expect.objectContaining({ err: expect.any(Error) }),
    );
    warnSpy.mockRestore();
  });
});

// ── #flushing guard ────────────────────────────────────────────────────────────

describe('buffer retention — #flushing guard', () => {
  it('#triggerFlush is no-op when a flush is already in-flight', async () => {
    const client = new HubClient({ ...CONFIG, maxBufferSize: 2, flushIntervalMs: 10_000 });
    await client.connect();

    // Make flush slow (hanging until we release it)
    let resolveFetch!: () => void;
    mockFetch.mockReturnValueOnce(
      new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(res => {
        resolveFetch = () => res({ ok: true, status: 200, json: async () => ({}) });
      }),
    );

    // Buffer 2 events → triggers size-threshold flush (in-flight now)
    client.trackUsage('t1', 'p1', { event_type: 'a', quantity: 1 });
    client.trackUsage('t1', 'p1', { event_type: 'b', quantity: 1 });
    await drainMicrotasks(); // flush starts, hangs on mockFetch

    // Buffer more events; trigger size threshold again → should be no-op (flushing=true)
    client.trackUsage('t1', 'p1', { event_type: 'c', quantity: 1 });
    client.trackUsage('t1', 'p1', { event_type: 'd', quantity: 1 });
    await drainMicrotasks();

    // Count ingest fetch calls — should only be 1 (the in-flight one)
    const ingestCallsBefore = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    ).length;
    expect(ingestCallsBefore).toBe(1);

    // Release the in-flight flush
    resolveFetch();
    await drainMicrotasks();
  });

  it('TODO-D-DEF-004 comment is present in HubClient source', async () => {
    const fs = await import('fs');
    const { fileURLToPath } = await import('url');
    const srcPath = fileURLToPath(new URL('../HubClient.ts', import.meta.url));
    const src = fs.readFileSync(srcPath, 'utf8');
    expect(src).toContain('TODO-D-DEF-004');
  });
});
