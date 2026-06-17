// Authorized by HUB-957 — unit tests: LeaseCache; cache hit; expired entry; inflight dedup; trackInflight cleanup

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LeaseCache } from '../leaseCache.js';
import type { DecryptedLease } from '../types.js';

afterEach(() => {
  vi.useRealTimers();
});

function makeLease(expiresAt = Date.now() + 86_400_000): DecryptedLease {
  return {
    tenantId: 'tenant-1',
    productId: 'product-x',
    features: ['f1'],
    maxSeats: 5,
    expiresAt,
  };
}

describe('LeaseCache', () => {
  it('returns null for a key that has not been set', () => {
    const cache = new LeaseCache();
    expect(cache.getCached('missing')).toBeNull();
  });

  it('returns the lease after set()', () => {
    const cache = new LeaseCache();
    const lease = makeLease();
    cache.set('k', lease);
    expect(cache.getCached('k')).toEqual(lease);
  });

  it('returns null and evicts expired entries', () => {
    vi.useFakeTimers();
    const cache = new LeaseCache();
    const expiresAt = Date.now() + 1000;
    cache.set('k', makeLease(expiresAt));
    vi.advanceTimersByTime(1001);
    expect(cache.getCached('k')).toBeNull();
  });

  it('getInflight returns null when no inflight is tracked', () => {
    const cache = new LeaseCache();
    expect(cache.getInflight('k')).toBeNull();
  });

  it('getInflight returns the tracked promise', () => {
    const cache = new LeaseCache();
    const p = new Promise<DecryptedLease>(() => {});
    cache.trackInflight('k', p);
    expect(cache.getInflight('k')).toBe(p);
  });

  it('inflight is removed after the promise resolves', async () => {
    const cache = new LeaseCache();
    let resolve!: (l: DecryptedLease) => void;
    const p = new Promise<DecryptedLease>(r => { resolve = r; });
    cache.trackInflight('k', p);
    resolve(makeLease());
    await p;
    expect(cache.getInflight('k')).toBeNull();
  });

  it('inflight is removed after the promise rejects', async () => {
    const cache = new LeaseCache();
    let reject!: (e: Error) => void;
    const p = new Promise<DecryptedLease>((_r, rej) => { reject = rej; });
    cache.trackInflight('k', p);
    reject(new Error('fail'));
    await p.catch(() => {});
    expect(cache.getInflight('k')).toBeNull();
  });

  it('invalidate removes cached entry', () => {
    const cache = new LeaseCache();
    cache.set('k', makeLease());
    cache.invalidate('k');
    expect(cache.getCached('k')).toBeNull();
  });

  it('invalidate removes inflight entry', async () => {
    const cache = new LeaseCache();
    let resolve!: (l: DecryptedLease) => void;
    const p = new Promise<DecryptedLease>(r => { resolve = r; });
    cache.trackInflight('k', p);
    cache.invalidate('k');
    expect(cache.getInflight('k')).toBeNull();
    resolve(makeLease());
    await p;
  });
});
