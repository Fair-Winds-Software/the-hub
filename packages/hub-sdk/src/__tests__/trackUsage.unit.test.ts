// Authorized by HUB-1006 — unit tests: trackUsage(); occurred_at stamping; capturedAt; size-threshold trigger

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
  maxBufferSize: 3,
  flushIntervalMs: 30_000,
  lateThresholdMs: 60_000,
  disconnectFlushTimeoutMs: 1_000,
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

// ── occurred_at stamping ───────────────────────────────────────────────────────

describe('trackUsage() — occurred_at stamping', () => {
  it('sets occurred_at to ISO8601 at call time', async () => {
    vi.setSystemTime(new Date('2025-01-15T10:00:00.000Z'));
    const client = new HubClient(CONFIG);
    await client.connect();

    // Set up mock for ingest flush (triggered by size threshold or manual)
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    client.trackUsage('t1', 'p1', { event_type: 'api_call', quantity: 1 });

    // Advance time — occurred_at must remain at capture time
    vi.setSystemTime(new Date('2025-01-15T10:05:00.000Z'));

    // Trigger flush via interval
    await vi.advanceTimersByTimeAsync(30_000);
    await drainMicrotasks();

    const body = JSON.parse((mockFetch.mock.calls.at(-1)![1] as RequestInit).body as string) as {
      events: Array<{ occurred_at: string }>;
    };
    expect(body.events[0]!.occurred_at).toBe('2025-01-15T10:00:00.000Z');
  });

  it('occurred_at is not overwritten between capture and flush', async () => {
    vi.setSystemTime(new Date('2025-01-15T10:00:00.000Z'));
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    client.trackUsage('t1', 'p1', { event_type: 'view', quantity: 1 });

    vi.setSystemTime(new Date('2025-01-15T11:00:00.000Z'));
    await vi.advanceTimersByTimeAsync(30_000);
    await drainMicrotasks();

    const body = JSON.parse((mockFetch.mock.calls.at(-1)![1] as RequestInit).body as string) as {
      events: Array<{ occurred_at: string }>;
    };
    expect(body.events[0]!.occurred_at).toBe('2025-01-15T10:00:00.000Z');
  });
});

// ── buffer append ──────────────────────────────────────────────────────────────

describe('trackUsage() — buffer append', () => {
  it('trackUsage() is synchronous and returns void', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const result = client.trackUsage('t1', 'p1', { event_type: 'click', quantity: 1 });
    expect(result).toBeUndefined();
  });

  it('trackUsage() never throws regardless of input', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    expect(() =>
      client.trackUsage('', '', { event_type: '', quantity: 0 }),
    ).not.toThrow();
    expect(() =>
      client.trackUsage('t1', 'p1', { event_type: 'x', quantity: -1 }),
    ).not.toThrow();
  });

  it('does not call fetch from within trackUsage()', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();
    const callsBefore = mockFetch.mock.calls.length;

    client.trackUsage('t1', 'p1', { event_type: 'api_call', quantity: 1 });

    expect(mockFetch.mock.calls.length).toBe(callsBefore); // no immediate fetch
  });
});

// ── size-threshold trigger ─────────────────────────────────────────────────────

describe('trackUsage() — size-threshold flush trigger', () => {
  it('triggers flush when buffer reaches maxBufferSize', async () => {
    const client = new HubClient(CONFIG); // maxBufferSize: 3
    await client.connect();

    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const callsBefore = mockFetch.mock.calls.length;

    client.trackUsage('t1', 'p1', { event_type: 'a', quantity: 1 }); // 1 — no flush
    client.trackUsage('t1', 'p1', { event_type: 'b', quantity: 1 }); // 2 — no flush
    client.trackUsage('t1', 'p1', { event_type: 'c', quantity: 1 }); // 3 — triggers flush

    await drainMicrotasks();

    const ingestCalls = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    expect(ingestCalls.length).toBe(1);
    expect(mockFetch.mock.calls.length).toBe(callsBefore + 1); // 1 ingest call added
  });

  it('flush triggered by size sends all buffered events', async () => {
    const client = new HubClient(CONFIG); // maxBufferSize: 3
    await client.connect();

    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    client.trackUsage('t1', 'p1', { event_type: 'a', quantity: 1 });
    client.trackUsage('t1', 'p1', { event_type: 'b', quantity: 2 });
    client.trackUsage('t1', 'p1', { event_type: 'c', quantity: 3 });

    await drainMicrotasks();

    const ingestCall = mockFetch.mock.calls.find(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    expect(ingestCall).toBeDefined();
    const body = JSON.parse((ingestCall![1] as RequestInit).body as string) as {
      events: Array<{ event_type: string; quantity: number }>;
    };
    expect(body.events).toHaveLength(3);
    expect(body.events[0]!.event_type).toBe('a');
    expect(body.events[2]!.quantity).toBe(3);
  });
});
