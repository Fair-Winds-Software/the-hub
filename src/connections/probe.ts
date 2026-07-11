// Authorized by HUB-1792 (S3 of HUB-1783 — Generalize the connections framework) — shared
// health-probe helper. Extracts the per-connection 15s cache + 3s timeout + rate-limit-vs-
// down classification pattern from HUB-1782 (S9 of HUB-1773 — the inline `probeLiveHealth`
// + `_cache` in src/routes/admin/connections.ts) into a reusable module so every connection
// (Stripe today; GA, Plaid, etc. tomorrow) uses the same probe semantics.
//
// runProbe() wraps a caller-supplied probe function with:
//   - hard timeout (default 3s; configurable per call)
//   - latency measurement
//   - error classification: rate-limit-like errors ('rate_limit', 'rate limit', '429') →
//     `degraded`; anything else → `down`; success within timeout → `ok`
//
// getCachedStatus() memoizes a per-connection ConnectionStatus for 15s. Cache key includes
// the current mode so a mode flip invalidates immediately; if the mode changes between two
// calls, the second call recomputes even if less than 15s elapsed.
import type { ConnectionHealth, ConnectionStatus, ProbeResult } from './base.js';
import { getConnectionMode } from './registry.js';

// ── runProbe ────────────────────────────────────────────────────────────────────

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const RATE_LIMIT_ERROR_PATTERN = /rate_limit|rate limit|429|resource_exhausted/i;

/**
 * Executes the caller-supplied probe function under a hard timeout, measures latency, and
 * classifies the outcome as ok / degraded / down. The `name` argument is only used for log
 * context — the shared runProbe helper doesn't touch the registry or any per-connection
 * state. Callers are expected to pass an already-configured probe (e.g. `() => adapter.probe()`).
 *
 * Rate-limit classification: an error whose message matches `rate_limit|rate limit|429|
 * resource_exhausted` is treated as `degraded` (the connection is still there, we just got
 * throttled). Any other error is `down`. Success within the timeout is `ok`.
 */
export async function runProbe(
  _name: string,
  probeFn: () => Promise<void>,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('probe timeout')), timeoutMs),
    );
    await Promise.race([probeFn(), timeout]);
    return { health: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    const message = (err as Error).message;
    const health: ConnectionHealth = RATE_LIMIT_ERROR_PATTERN.test(message) ? 'degraded' : 'down';
    return { health, reason: message, latency_ms: Date.now() - start };
  }
}

// ── getCachedStatus ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  key: string; // mode:<currentMode>
  result: ConnectionStatus;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

/**
 * Returns a cached ConnectionStatus for the named connection, computing fresh when the
 * cache is empty, expired, or the mode changed since the last cache write. `computeFn` is
 * called only on cache miss and is expected to return the full ConnectionStatus (including
 * mode and checked_at).
 */
export async function getCachedStatus(
  name: string,
  computeFn: () => Promise<ConnectionStatus>,
): Promise<ConnectionStatus> {
  const mode = getConnectionMode(name);
  const key = `mode:${mode}`;
  const now = Date.now();
  const existing = _cache.get(name);
  if (existing && existing.key === key && existing.expiresAt > now) {
    return existing.result;
  }
  const result = await computeFn();
  _cache.set(name, { key, result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

// ── Test hooks ──────────────────────────────────────────────────────────────────

/** Test-only: clears the probe cache for one connection, or all if omitted. */
export function _resetStatusCacheForTest(name?: string): void {
  if (name) _cache.delete(name);
  else _cache.clear();
}
