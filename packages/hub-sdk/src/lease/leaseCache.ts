// Authorized by HUB-942 — in-memory lease cache with TTL check, inflight deduplication, and background refresh stub

import type { DecryptedLease } from './types.js';

interface CacheEntry {
  lease: DecryptedLease;
  fetchedAt: number;
}

export class LeaseCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<DecryptedLease>>();

  getCached(key: string): DecryptedLease | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.lease.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    // TODO-D-DEF-002: background refresh threshold not yet defined; background refresh disabled at v1
    return entry.lease;
  }

  set(key: string, lease: DecryptedLease): void {
    // TODO-D-DEF-005: cache eviction strategy not yet defined; cache grows unbounded at v1
    this.cache.set(key, { lease, fetchedAt: Date.now() });
  }

  getInflight(key: string): Promise<DecryptedLease> | null {
    return this.inflight.get(key) ?? null;
  }

  trackInflight(key: string, promise: Promise<DecryptedLease>): void {
    this.inflight.set(key, promise);
    // .catch() prevents the derived .finally() promise from becoming an unhandled rejection;
    // callers awaiting the original promise still receive the rejection normally.
    promise.finally(() => {
      this.inflight.delete(key);
    }).catch(() => {});
  }

  invalidate(key: string): void {
    this.cache.delete(key);
    this.inflight.delete(key);
  }
}
