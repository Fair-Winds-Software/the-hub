// Authorized by HUB-1006 — unit tests: ping(); ok/fail/latency; exactly 1 fetch; no state mutation

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
  disconnectFlushTimeoutMs: 1_000,
  versionReportIntervalMs: 3_600_000,
};

beforeEach(() => {
  vi.useFakeTimers();
  mockAcquireToken.mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 3_600_000 });
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

// ── happy path ─────────────────────────────────────────────────────────────────

describe('ping() — happy path', () => {
  it('returns ok=true and latencyMs≥0 on HTTP 200', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });

    const result = await client.ping();

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('GETs the correct /api/v1/health URL with Bearer token', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    await client.ping();

    const healthCall = mockFetch.mock.calls.find(
      ([url]) => (url as string).includes('/api/v1/health'),
    );
    expect(healthCall).toBeDefined();
    const [url, opts] = healthCall! as [string, RequestInit];
    expect(url).toBe('https://hub.example.com/api/v1/health');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });
});

// ── error cases ────────────────────────────────────────────────────────────────

describe('ping() — error cases', () => {
  it('returns ok=false and latencyMs≥0 on HTTP 500', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const result = await client.ping();

    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok=false and latencyMs≥0 on network error — never throws', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // ping() must resolve, not reject
    const result = await client.ping();

    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves (does not reject) even on network error', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(client.ping()).resolves.toBeDefined();
  });
});

// ── exactly 1 fetch call ───────────────────────────────────────────────────────

describe('ping() — exactly 1 fetch call', () => {
  it('makes exactly 1 fetch call per ping() invocation', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    const callsBefore = mockFetch.mock.calls.length;

    await client.ping();

    expect(mockFetch.mock.calls.length).toBe(callsBefore + 1);
  });

  it('does not retry on non-401 failure — exactly 1 fetch on 500', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const callsBefore = mockFetch.mock.calls.length;

    await client.ping();

    expect(mockFetch.mock.calls.length).toBe(callsBefore + 1);
  });
});

// ── no state mutation ──────────────────────────────────────────────────────────

describe('ping() — no state mutation', () => {
  it('does not affect the token state', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const tokenBefore = (client as any).token as string;
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await client.ping();

    expect((client as any).token).toBe(tokenBefore);
  });
});
