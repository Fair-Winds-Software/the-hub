// Authorized by HUB-914 — unit tests: HubClient constructor; connect() idempotency; refresh threshold;
//   concurrent refresh single promise; #refreshPromise cleared; 401 auto-retry; non-401 not retried
// Updated for HUB-986 — connect() now calls #reportVersion(); fetch stubbed to prevent real network calls

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HubAuthError } from '../errors.js';

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
  tokenRefreshThresholdMs: 60_000,
};

function resolveToken(token = 'tok', ttlMs = 3_600_000): void {
  mockAcquireToken.mockResolvedValue({ token, expiresAt: Date.now() + ttlMs });
}

beforeEach(() => {
  vi.useFakeTimers();
  resolveToken();
  // Stub fetch so connect()'s #reportVersion() doesn't make real network calls
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

// ── Constructor ────────────────────────────────────────────────────────────────

describe('HubClient constructor', () => {
  it('throws TypeError when clientId is empty', () => {
    expect(() => new HubClient({ ...CONFIG, clientId: '' })).toThrow(TypeError);
  });

  it('throws TypeError when clientSecret is empty', () => {
    expect(() => new HubClient({ ...CONFIG, clientSecret: '' })).toThrow(TypeError);
  });

  it('throws TypeError when hubUrl is empty', () => {
    expect(() => new HubClient({ ...CONFIG, hubUrl: '' })).toThrow(TypeError);
  });

  it('constructs with valid config and token is initially null', () => {
    const client = new HubClient(CONFIG);
    expect(client).toBeInstanceOf(HubClient);
    expect((client as any).token).toBeNull();
  });
});

// ── connect() ─────────────────────────────────────────────────────────────────

describe('HubClient connect()', () => {
  it('acquires a token on first connect()', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();
    expect(mockAcquireToken).toHaveBeenCalledOnce();
  });

  it('is idempotent — second connect() does not re-acquire when token is fresh', async () => {
    resolveToken('tok', 7_200_000); // 2h until expiry; threshold 60s
    const client = new HubClient(CONFIG);
    await client.connect();
    await client.connect();
    expect(mockAcquireToken).toHaveBeenCalledOnce();
  });

  it('rejects with HubAuthError when auth endpoint returns 401', async () => {
    mockAcquireToken.mockRejectedValueOnce(new HubAuthError('Token acquisition failed', 401));
    const client = new HubClient(CONFIG);
    await expect(client.connect()).rejects.toBeInstanceOf(HubAuthError);
  });

  it('token is not accessible via any public property', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();
    const publicKeys = Object.keys(client).filter(
      k => !(client as any)[k] && typeof (client as any)[k] !== 'object',
    );
    expect(publicKeys).not.toContain('token');
  });
});

// ── ensureFreshToken ───────────────────────────────────────────────────────────

describe('ensureFreshToken — threshold and concurrent refresh', () => {
  it('does not re-acquire when token is well within expiry threshold', async () => {
    resolveToken('tok', 7_200_000); // 2h until expiry
    const client = new HubClient(CONFIG);
    await client.connect();
    await client.connect(); // still fresh
    expect(mockAcquireToken).toHaveBeenCalledOnce();
  });

  it('re-acquires when token is within the threshold window', async () => {
    // First token expires in 30s (well within 60s threshold)
    mockAcquireToken
      .mockResolvedValueOnce({ token: 'old-tok', expiresAt: Date.now() + 30_000 })
      .mockResolvedValueOnce({ token: 'new-tok', expiresAt: Date.now() + 3_600_000 });
    const client = new HubClient(CONFIG);
    await client.connect();
    await client.connect(); // old-tok is within threshold → re-acquire
    expect(mockAcquireToken).toHaveBeenCalledTimes(2);
  });

  it('concurrent connect() calls share a single in-flight refresh promise', async () => {
    const client = new HubClient(CONFIG);
    await Promise.all([
      client.connect(),
      client.connect(),
      client.connect(),
      client.connect(),
      client.connect(),
    ]);
    expect(mockAcquireToken).toHaveBeenCalledOnce();
  });

  it('clears refreshPromise to null after successful refresh', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();
    expect((client as any).refreshPromise).toBeNull();
  });

  it('clears refreshPromise to null after failed refresh', async () => {
    mockAcquireToken.mockRejectedValueOnce(new HubAuthError('fail', 500));
    const client = new HubClient(CONFIG);
    await client.connect().catch(() => {});
    expect((client as any).refreshPromise).toBeNull();
  });
});

// ── 401 auto-retry ────────────────────────────────────────────────────────────

describe('requestWithRetry — 401 auto-retry', () => {
  it('retries request once on 401 and resolves on second success', async () => {
    const client = new HubClient(CONFIG);
    await client.connect(); // acquire initial token
    resolveToken('new-tok'); // re-auth will return new-tok

    const requestFn = vi.fn()
      .mockResolvedValueOnce({ status: 401, ok: false } as Response)
      .mockResolvedValueOnce({ status: 200, ok: true } as Response);

    const response = await (client as any).requestWithRetry(requestFn) as Response;
    expect(response.status).toBe(200);
    expect(requestFn).toHaveBeenCalledTimes(2);
    expect(mockAcquireToken).toHaveBeenCalledTimes(2); // initial + re-auth
  });

  it('throws HubAuthError when retry also returns 401', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();
    resolveToken('new-tok');

    const requestFn = vi.fn().mockResolvedValue({ status: 401, ok: false } as Response);
    await expect((client as any).requestWithRetry(requestFn)).rejects.toBeInstanceOf(HubAuthError);
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 403 — returns response directly', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const requestFn = vi.fn().mockResolvedValue({ status: 403, ok: false } as Response);
    const response = await (client as any).requestWithRetry(requestFn) as Response;
    expect(response.status).toBe(403);
    expect(requestFn).toHaveBeenCalledOnce();
  });

  it('does not retry on 500 — returns response directly', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const requestFn = vi.fn().mockResolvedValue({ status: 500, ok: false } as Response);
    const response = await (client as any).requestWithRetry(requestFn) as Response;
    expect(response.status).toBe(500);
    expect(requestFn).toHaveBeenCalledOnce();
  });

  it('does not retry on 429 — returns response directly', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    const requestFn = vi.fn().mockResolvedValue({ status: 429, ok: false } as Response);
    const response = await (client as any).requestWithRetry(requestFn) as Response;
    expect(response.status).toBe(429);
    expect(requestFn).toHaveBeenCalledOnce();
  });

  it('clears token and tokenExpiry before re-auth on 401', async () => {
    const client = new HubClient(CONFIG);
    await client.connect();

    let tokenAtReauth: string | null = undefined as unknown as string | null;
    let expiryAtReauth: number | null = undefined as unknown as number | null;

    mockAcquireToken.mockImplementationOnce(async () => {
      tokenAtReauth = (client as any).token as string | null;
      expiryAtReauth = (client as any).tokenExpiry as number | null;
      return { token: 'new-tok', expiresAt: Date.now() + 3_600_000 };
    });

    const requestFn = vi.fn()
      .mockResolvedValueOnce({ status: 401, ok: false } as Response)
      .mockResolvedValueOnce({ status: 200, ok: true } as Response);

    await (client as any).requestWithRetry(requestFn);
    expect(tokenAtReauth).toBeNull();
    expect(expiryAtReauth).toBeNull();
  });
});
