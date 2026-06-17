// Authorized by HUB-914 — unit tests: acquireToken(); 200 happy path; 4xx/5xx → HubAuthError; timeout; secret scrubbing

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

import { acquireToken } from '../acquireToken.js';
import { HubAuthError } from '../../errors.js';

beforeEach(() => {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'tok123', expires_in: 3600 }),
  });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('acquireToken', () => {
  it('returns { token, expiresAt } on 200', async () => {
    const before = Date.now();
    const result = await acquireToken('https://hub.example.com', 'cid', 'csec', 10000);
    expect(result.token).toBe('tok123');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100);
    expect(result.expiresAt).toBeLessThanOrEqual(before + 3600 * 1000 + 100);
  });

  it('POSTs to ${hubUrl}/api/v1/auth/token with correct headers and method', async () => {
    await acquireToken('https://hub.example.com', 'cid', 'csec', 10000);
    const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://hub.example.com/api/v1/auth/token');
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body as string) as { client_id: string; client_secret: string };
    expect(body.client_id).toBe('cid');
  });

  it('throws HubAuthError with statusCode 401 on 401 response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const err = await acquireToken('https://hub.example.com', 'cid', 'csec', 10000).catch(e => e);
    expect(err).toBeInstanceOf(HubAuthError);
    expect((err as HubAuthError).statusCode).toBe(401);
  });

  it('throws HubAuthError with statusCode 503 on 503 response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const err = await acquireToken('https://hub.example.com', 'cid', 'csec', 10000).catch(e => e);
    expect(err).toBeInstanceOf(HubAuthError);
    expect((err as HubAuthError).statusCode).toBe(503);
  });

  it('propagates network TypeError without wrapping in HubAuthError', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const err = await acquireToken('https://hub.example.com', 'cid', 'csec', 10000).catch(e => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(HubAuthError);
  });

  it('aborts request after timeoutMs via AbortController', async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementationOnce((_url: string, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (opts.signal as AbortSignal).addEventListener('abort', () =>
          reject(new Error('The operation was aborted')),
        );
      });
    });
    const p = acquireToken('https://hub.example.com', 'cid', 'csec', 5000);
    vi.advanceTimersByTime(5001);
    await expect(p).rejects.toThrow();
    vi.useRealTimers();
  });

  it('clientSecret does not appear in thrown error message', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const err = await acquireToken('https://hub.example.com', 'cid', 'super-secret-xyz', 10000).catch(e => e);
    expect((err as Error).message).not.toContain('super-secret-xyz');
  });
});
