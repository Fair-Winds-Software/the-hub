// Authorized by HUB-1006 — unit tests: flush engine; interval trigger; ingested_late flag; empty buffer no-op; TODO-D-DEF-003

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

// ── interval trigger ───────────────────────────────────────────────────────────

describe('flush engine — interval trigger', () => {
  it('sends buffered events on interval tick', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    client.trackUsage('t1', 'p1', { event_type: 'api_call', quantity: 1 });
    client.trackUsage('t1', 'p1', { event_type: 'api_call', quantity: 2 });

    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    const ingestCalls = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    expect(ingestCalls.length).toBeGreaterThanOrEqual(1);

    const body = JSON.parse((ingestCalls[0]![1] as RequestInit).body as string) as {
      events: Array<{ event_type: string; quantity: number }>;
    };
    expect(body.events).toHaveLength(2);
  });

  it('does not make a fetch call when buffer is empty at interval tick', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const callsBefore = mockFetch.mock.calls.length;

    // Advance past flush interval — no events buffered
    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    expect(mockFetch.mock.calls.length).toBe(callsBefore); // no ingest call added
  });
});

// ── ingested_late flag ─────────────────────────────────────────────────────────

describe('flush engine — ingested_late flag', () => {
  it('sets ingested_late=true when capturedAt is beyond lateThresholdMs before flush', async () => {
    vi.setSystemTime(new Date('2025-01-15T10:00:00.000Z'));
    const client = new HubClient({ ...CONFIG, lateThresholdMs: 5_000 });
    await client.connect();

    client.trackUsage('t1', 'p1', { event_type: 'old_event', quantity: 1 });

    // Advance time past the late threshold before the interval fires
    vi.setSystemTime(new Date('2025-01-15T10:00:06.000Z')); // 6s later, threshold=5s

    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    const ingestCall = mockFetch.mock.calls.find(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    const body = JSON.parse((ingestCall![1] as RequestInit).body as string) as {
      events: Array<{ ingested_late: boolean }>;
    };
    expect(body.events[0]!.ingested_late).toBe(true);
  });

  it('sets ingested_late=false when capturedAt is within lateThresholdMs', async () => {
    vi.setSystemTime(new Date('2025-01-15T10:00:00.000Z'));
    const client = new HubClient({ ...CONFIG, lateThresholdMs: 60_000 });
    await client.connect();

    client.trackUsage('t1', 'p1', { event_type: 'fresh_event', quantity: 1 });

    // Only 2 seconds pass — well within 60s threshold
    vi.setSystemTime(new Date('2025-01-15T10:00:02.000Z'));

    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    const ingestCall = mockFetch.mock.calls.find(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    const body = JSON.parse((ingestCall![1] as RequestInit).body as string) as {
      events: Array<{ ingested_late: boolean }>;
    };
    expect(body.events[0]!.ingested_late).toBe(false);
  });

  it('occurred_at is unchanged in flushed payload — reflects capture time not flush time', async () => {
    vi.setSystemTime(new Date('2025-01-15T10:00:00.000Z'));
    const client = new HubClient(CONFIG);
    await client.connect();

    client.trackUsage('t1', 'p1', { event_type: 'api_call', quantity: 1 });

    vi.setSystemTime(new Date('2025-01-15T10:30:00.000Z'));
    await vi.advanceTimersByTimeAsync(10_000);
    await drainMicrotasks();

    const ingestCall = mockFetch.mock.calls.find(
      ([url]) => (url as string).includes('/api/v1/usage/ingest'),
    );
    const body = JSON.parse((ingestCall![1] as RequestInit).body as string) as {
      events: Array<{ occurred_at: string }>;
    };
    expect(body.events[0]!.occurred_at).toBe('2025-01-15T10:00:00.000Z');
  });
});

// ── TODO-D-DEF-003 marker ──────────────────────────────────────────────────────

describe('flush engine — TODO-D-DEF-003 marker', () => {
  it('TODO-D-DEF-003 comment is present in HubClient source', async () => {
    const fs = await import('fs');
    const { fileURLToPath } = await import('url');
    const srcPath = fileURLToPath(new URL('../HubClient.ts', import.meta.url));
    const src = fs.readFileSync(srcPath, 'utf8');
    expect(src).toContain('TODO-D-DEF-003');
  });
});
