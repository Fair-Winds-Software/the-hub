// Authorized by HUB-1006 — unit tests: disconnect(); clearInterval; flush race; timeout path; auth fields cleared

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
  flushIntervalMs: 30_000,
  lateThresholdMs: 60_000,
  disconnectFlushTimeoutMs: 2_000,
  versionReportIntervalMs: 3_600_000,
};

async function drainMicrotasks(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockAcquireToken.mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 3_600_000 });
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

// ── empty buffer ───────────────────────────────────────────────────────────────

describe('disconnect() — empty buffer', () => {
  it('resolves immediately with no ingest fetch when buffer is empty', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();
    const callsBefore = mockFetch.mock.calls.length;

    await client.disconnect();

    const ingestCalls = mockFetch.mock.calls
      .slice(callsBefore)
      .filter(([url]) => (url as string).includes('/api/v1/usage/ingest'));
    expect(ingestCalls).toHaveLength(0);
  });
});

// ── fast flush path ────────────────────────────────────────────────────────────

describe('disconnect() — fast flush path', () => {
  it('flushes remaining events and resolves cleanly within timeout', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HubClient(CONFIG);
    await client.connect();

    client.trackUsage('t1', 'p1', { event_type: 'ev', quantity: 1 });

    const disconnectPromise = client.disconnect();
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    await disconnectPromise;

    const ingestCalls = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    expect(ingestCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnSpy).not.toHaveBeenCalledWith(
      'disconnect() timeout; events may be lost',
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

// ── timeout path ───────────────────────────────────────────────────────────────

describe('disconnect() — timeout path', () => {
  it('emits console.warn and still resolves when flush exceeds disconnectFlushTimeoutMs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HubClient(CONFIG); // disconnectFlushTimeoutMs: 2000

    await client.connect();
    client.trackUsage('t1', 'p1', { event_type: 'ev', quantity: 1 });

    // Make the ingest call hang indefinitely
    mockFetch.mockReturnValueOnce(new Promise(() => {}));

    const disconnectPromise = client.disconnect();

    // Advance past the disconnectFlushTimeoutMs
    await vi.advanceTimersByTimeAsync(2_000);
    await drainMicrotasks();

    await disconnectPromise; // must resolve (not hang)

    expect(warnSpy).toHaveBeenCalledWith(
      'disconnect() timeout; events may be lost',
      expect.objectContaining({ remainingCount: expect.any(Number) }),
    );
    warnSpy.mockRestore();
  });
});

// ── auth fields cleared ────────────────────────────────────────────────────────

describe('disconnect() — auth fields cleared', () => {
  it('sets token, tokenExpiry, and refreshPromise to null after disconnect()', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    expect((client as any).token).not.toBeNull();

    await client.disconnect();

    expect((client as any).token).toBeNull();
    expect((client as any).tokenExpiry).toBeNull();
    expect((client as any).refreshPromise).toBeNull();
  });
});

// ── timer cleanup ──────────────────────────────────────────────────────────────

describe('disconnect() — timer cleanup', () => {
  it('stops the flush interval so no more ingest calls fire after disconnect()', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    await client.disconnect();

    const callsAfterDisconnect = mockFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); // flush interval would have fired
    await drainMicrotasks();

    // No additional calls after disconnect
    expect(mockFetch.mock.calls.length).toBe(callsAfterDisconnect);
  });

  it('reconnect after disconnect() starts timers fresh', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();
    await client.disconnect();

    // Re-connect
    mockAcquireToken.mockResolvedValue({ token: 'tok2', expiresAt: Date.now() + 3_600_000 });
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await client.connect();

    client.trackUsage('t1', 'p1', { event_type: 'ev', quantity: 1 });

    await vi.advanceTimersByTimeAsync(30_000);
    await drainMicrotasks();

    const ingestCalls = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    expect(ingestCalls.length).toBeGreaterThanOrEqual(1);
  });
});
