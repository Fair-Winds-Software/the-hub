// Authorized by HUB-957 — integration tests: HubClient.getLease(); happy path; kill-switch; cache hit;
//   inflight dedup; non-2xx response; missing encryption key; LEASE_ENCRYPTION_KEY validation in connect()

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HubLeaseInvalidError, HubKillSwitchError } from '../errors.js';

const mockAcquireToken = vi.hoisted(() => vi.fn());
vi.mock('../auth/acquireToken.js', () => ({ acquireToken: mockAcquireToken }));

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

import { HubClient } from '../HubClient.js';
import {
  TEST_ENC_KEY,
  TEST_CLIENT_SECRET,
  makePayload,
  makeLeaseToken,
} from '../lease/__tests__/leaseFactory.js';

const CONFIG = {
  clientId: 'cid',
  clientSecret: TEST_CLIENT_SECRET,
  hubUrl: 'https://hub.example.com',
  timeoutMs: 5000,
};

function resolveToken(token = 'tok', ttlMs = 3_600_000): void {
  mockAcquireToken.mockResolvedValue({ token, expiresAt: Date.now() + ttlMs });
}

function respondWithLease(token: string): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ lease_token: token }),
  });
}

beforeEach(() => {
  resolveToken();
  process.env.LEASE_ENCRYPTION_KEY = TEST_ENC_KEY.toString('base64');
});

afterEach(() => {
  vi.resetAllMocks();
  delete process.env.LEASE_ENCRYPTION_KEY;
});

// ── connect() LEASE_ENCRYPTION_KEY validation ──────────────────────────────────

describe('connect() — LEASE_ENCRYPTION_KEY validation', () => {
  it('succeeds when LEASE_ENCRYPTION_KEY is absent (auth-only use case)', async () => {
    delete process.env.LEASE_ENCRYPTION_KEY;
    const client = new HubClient(CONFIG);
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('throws TypeError when LEASE_ENCRYPTION_KEY decodes to fewer than 32 bytes', async () => {
    process.env.LEASE_ENCRYPTION_KEY = Buffer.alloc(10).toString('base64');
    const client = new HubClient(CONFIG);
    await expect(client.connect()).rejects.toBeInstanceOf(TypeError);
  });

  it('succeeds when LEASE_ENCRYPTION_KEY decodes to exactly 32 bytes', async () => {
    process.env.LEASE_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
    const client = new HubClient(CONFIG);
    await expect(client.connect()).resolves.toBeUndefined();
  });
});

// ── getLease() happy path ─────────────────────────────────────────────────────

describe('HubClient getLease() — happy path', () => {
  it('returns a DecryptedLease with correct fields', async () => {
    const payload = makePayload({ tenantId: 't1', productId: 'p1' });
    const token = makeLeaseToken(payload);
    respondWithLease(token);

    const client = new HubClient(CONFIG);
    await client.connect();
    const lease = await client.getLease('t1', 'p1');

    expect(lease.tenantId).toBe('t1');
    expect(lease.productId).toBe('p1');
    expect(lease.features).toEqual(payload.features);
    expect(lease.maxSeats).toBe(payload.maxSeats);
    expect(lease.expiresAt).toBe(payload.expiresAt);
  });

  it('DecryptedLease does not expose killSwitch field', async () => {
    const payload = makePayload();
    respondWithLease(makeLeaseToken(payload));

    const client = new HubClient(CONFIG);
    await client.connect();
    const lease = await client.getLease('t1', 'p1');

    expect((lease as Record<string, unknown>)['killSwitch']).toBeUndefined();
  });

  it('calls the correct URL with Bearer token', async () => {
    const payload = makePayload({ tenantId: 'tenant-A', productId: 'prod-B' });
    respondWithLease(makeLeaseToken(payload));

    const client = new HubClient(CONFIG);
    await client.connect();
    await client.getLease('tenant-A', 'prod-B');

    const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://hub.example.com/api/v1/leases/tenant-A/prod-B');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });
});

// ── getLease() cache ──────────────────────────────────────────────────────────

describe('HubClient getLease() — cache', () => {
  it('returns cached lease on second call without hitting HTTP', async () => {
    const payload = makePayload();
    respondWithLease(makeLeaseToken(payload));

    const client = new HubClient(CONFIG);
    await client.connect();
    await client.getLease('t1', 'p1');
    await client.getLease('t1', 'p1'); // from cache

    expect(mockFetch).toHaveBeenCalledOnce(); // only 1 HTTP call (the auth token)
  });

  it('concurrent getLease() calls for the same key share a single inflight promise', async () => {
    const payload = makePayload();
    respondWithLease(makeLeaseToken(payload));

    const client = new HubClient(CONFIG);
    await client.connect();

    const [l1, l2, l3] = await Promise.all([
      client.getLease('t1', 'p1'),
      client.getLease('t1', 'p1'),
      client.getLease('t1', 'p1'),
    ]);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(l1).toEqual(l2);
    expect(l2).toEqual(l3);
  });
});

// ── getLease() kill-switch ────────────────────────────────────────────────────

describe('HubClient getLease() — kill-switch', () => {
  it('throws HubKillSwitchError when killSwitch is true', async () => {
    const payload = makePayload({ killSwitch: true });
    respondWithLease(makeLeaseToken(payload));

    const client = new HubClient(CONFIG);
    await client.connect();

    await expect(client.getLease('t1', 'p1')).rejects.toBeInstanceOf(HubKillSwitchError);
  });

  it('HubKillSwitchError carries tenantId and productId', async () => {
    const payload = makePayload({ tenantId: 'evil-tenant', productId: 'prod-x', killSwitch: true });
    respondWithLease(makeLeaseToken(payload));

    const client = new HubClient(CONFIG);
    await client.connect();

    const err = await client.getLease('evil-tenant', 'prod-x').catch(e => e);
    expect(err).toBeInstanceOf(HubKillSwitchError);
    expect((err as HubKillSwitchError).tenantId).toBe('evil-tenant');
    expect((err as HubKillSwitchError).productId).toBe('prod-x');
  });

  it('does not cache a kill-switched lease — subsequent call re-fetches', async () => {
    const killed = makePayload({ killSwitch: true });
    const alive = makePayload({ killSwitch: false });
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ lease_token: makeLeaseToken(killed) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ lease_token: makeLeaseToken(alive) }),
      });

    const client = new HubClient(CONFIG);
    await client.connect();
    await client.getLease('t1', 'p1').catch(() => {});
    const lease = await client.getLease('t1', 'p1');

    expect(lease.tenantId).toBe(alive.tenantId);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── getLease() error cases ────────────────────────────────────────────────────

describe('HubClient getLease() — error cases', () => {
  it('throws HubLeaseInvalidError when connect() was not called (no encryption key)', async () => {
    delete process.env.LEASE_ENCRYPTION_KEY;
    const client = new HubClient(CONFIG);
    await client.connect();

    await expect(client.getLease('t1', 'p1')).rejects.toBeInstanceOf(HubLeaseInvalidError);
  });

  it('throws HubLeaseInvalidError on non-2xx HTTP response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

    const client = new HubClient(CONFIG);
    await client.connect();

    await expect(client.getLease('t1', 'p1')).rejects.toBeInstanceOf(HubLeaseInvalidError);
  });

  it('throws HubLeaseInvalidError when lease_token signature is invalid', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ lease_token: 'invalidbase64.badhex0000000000000000000000000000000000000000000000000000000000' }),
    });

    const client = new HubClient(CONFIG);
    await client.connect();

    await expect(client.getLease('t1', 'p1')).rejects.toBeInstanceOf(HubLeaseInvalidError);
  });
});
