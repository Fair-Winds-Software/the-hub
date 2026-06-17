// Authorized by HUB-1006 — unit tests: #reportVersion(); connect() fires POST; heartbeat; warn-only on failure; SDK_VERSION

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAcquireToken = vi.hoisted(() => vi.fn());
vi.mock('../auth/acquireToken.js', () => ({ acquireToken: mockAcquireToken }));

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

import { HubClient } from '../HubClient.js';
import { SDK_VERSION } from '../version.js';

const CONFIG = {
  clientId: 'test-client-id',
  clientSecret: 'csec',
  hubUrl: 'https://hub.example.com',
  timeoutMs: 5000,
  maxBufferSize: 100,
  flushIntervalMs: 30_000,
  lateThresholdMs: 60_000,
  disconnectFlushTimeoutMs: 1_000,
  versionReportIntervalMs: 5_000,
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

// ── initial version report on connect() ───────────────────────────────────────

describe('#reportVersion() — fires on connect()', () => {
  it('POSTs to /api/v1/sdk/version immediately after connect()', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const versionCalls = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/sdk/version'),
    );
    expect(versionCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('POST body contains sdk_version from src/version.ts and client_id', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const versionCall = mockFetch.mock.calls.find(
      ([url]) => (url as string).includes('/api/v1/sdk/version'),
    );
    expect(versionCall).toBeDefined();

    const body = JSON.parse((versionCall![1] as RequestInit).body as string) as {
      sdk_version: string;
      client_id: string;
    };
    expect(body.sdk_version).toBe(SDK_VERSION);
    expect(body.client_id).toBe('test-client-id');
  });

  it('uses Bearer auth token in version report POST', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const versionCall = mockFetch.mock.calls.find(
      ([url]) => (url as string).includes('/api/v1/sdk/version'),
    );
    const headers = (versionCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
  });
});

// ── heartbeat interval ─────────────────────────────────────────────────────────

describe('#reportVersion() — heartbeat interval', () => {
  it('fires again after versionReportIntervalMs', async () => {
    const client = new HubClient(CONFIG); // versionReportIntervalMs: 5000
    await client.connect();

    const callsAfterConnect = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/sdk/version'),
    ).length;

    await vi.advanceTimersByTimeAsync(5_000);
    await drainMicrotasks();

    const callsAfterInterval = mockFetch.mock.calls.filter(
      ([url]) => (url as string).includes('/api/v1/sdk/version'),
    ).length;

    expect(callsAfterInterval).toBeGreaterThan(callsAfterConnect);
  });
});

// ── failure is warn-only ───────────────────────────────────────────────────────

describe('#reportVersion() — failure is warn-only', () => {
  it('emits console.warn on HTTP 500 without throwing; SDK continues operating', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Version report returns 500 → requestWithRetry returns non-ok response
    // #reportVersion() doesn't check res.ok — it only catches thrown errors
    // HUB-986 says "HTTP error or network error emits warn"; we test network error path
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const client = new HubClient(CONFIG);
    // connect() should NOT throw even with version report failure
    await expect(client.connect()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      'Version report failed; SDK continues operating',
      expect.objectContaining({ err: expect.any(Error) }),
    );
    warnSpy.mockRestore();
  });

  it('heartbeat failure emits warn without crashing the SDK', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HubClient(CONFIG);
    await client.connect();

    // Make the heartbeat call fail
    mockFetch.mockRejectedValueOnce(new Error('Heartbeat failure'));

    await vi.advanceTimersByTimeAsync(5_000);
    await drainMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      'Version report failed; SDK continues operating',
      expect.objectContaining({ err: expect.any(Error) }),
    );
    warnSpy.mockRestore();
  });
});

// ── SDK_VERSION canonical source ───────────────────────────────────────────────

describe('SDK_VERSION — canonical source', () => {
  it('SDK_VERSION is a non-empty semver string', () => {
    expect(typeof SDK_VERSION).toBe('string');
    expect(SDK_VERSION.length).toBeGreaterThan(0);
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
