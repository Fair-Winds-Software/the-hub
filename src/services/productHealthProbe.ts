// Authorized by HUB-1545 (System Health spec-deviation close-out) —
// per-product HTTP liveness probe. On-demand execution inside
// computePortfolio() with a 60s freshness TTL: if last_probe_at is
// within TTL we reuse the last result; otherwise we HEAD (falling back
// to GET) the health_check_url with a 5s timeout and write the result
// back to the row.
//
// Products without a health_check_url are treated as "probe not
// configured" and computePortfolio() falls back to the pre-064
// behaviour (uses products.active as the reachability proxy).

import { getPool } from '../db/pool.js';

export const PROBE_TTL_MS = 60_000;
export const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeInput {
  product_id: string;
  health_check_url: string | null;
  last_probe_at: Date | null;
  last_probe_reachable: boolean | null;
  last_probe_error: string | null;
  last_probe_latency_ms: number | null;
}

export interface ProbeResult {
  reachable: boolean;
  probedAt: Date;
  latencyMs: number | null;
  error: string | null;
}

/**
 * Return the current probe result for a product. If a fresh cached value
 * exists (last_probe_at within PROBE_TTL_MS) we return it without a
 * network round-trip; otherwise we execute a probe + persist + return.
 */
export async function getOrExecuteProbe(
  input: ProbeInput,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  if (input.last_probe_at !== null) {
    const ageMs = now - input.last_probe_at.getTime();
    if (ageMs < PROBE_TTL_MS && input.last_probe_reachable !== null) {
      return {
        reachable: input.last_probe_reachable,
        probedAt: input.last_probe_at,
        latencyMs: input.last_probe_latency_ms,
        error: input.last_probe_error,
      };
    }
  }
  if (!input.health_check_url) {
    // Caller decides the fallback (e.g., use products.active).
    return {
      reachable: false,
      probedAt: new Date(now),
      latencyMs: null,
      error: 'no health_check_url configured',
    };
  }
  return executeProbe(input.product_id, input.health_check_url, fetchImpl);
}

async function executeProbe(
  productId: string,
  url: string,
  fetchImpl: typeof fetch,
): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let reachable = false;
  let error: string | null = null;
  try {
    const res = await fetchImpl(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    // 2xx / 3xx counts as reachable; some services 405 on HEAD, in which
    // case we retry with GET.
    if (res.ok || (res.status >= 200 && res.status < 400)) {
      reachable = true;
    } else if (res.status === 405) {
      const getRes = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
      });
      reachable = getRes.ok || (getRes.status >= 200 && getRes.status < 400);
      if (!reachable) error = `HTTP ${getRes.status}`;
    } else {
      error = `HTTP ${res.status}`;
    }
  } catch (err) {
    error = (err as Error).name === 'AbortError'
      ? `timeout after ${PROBE_TIMEOUT_MS}ms`
      : (err as Error).message;
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  const probedAt = new Date();

  await persistProbeResult(productId, probedAt, reachable, latencyMs, error);

  return { reachable, probedAt, latencyMs, error };
}

async function persistProbeResult(
  productId: string,
  probedAt: Date,
  reachable: boolean,
  latencyMs: number,
  error: string | null,
): Promise<void> {
  try {
    await getPool().query(
      `UPDATE products
          SET last_probe_at = $2,
              last_probe_reachable = $3,
              last_probe_latency_ms = $4,
              last_probe_error = $5
        WHERE id = $1`,
      [productId, probedAt, reachable, latencyMs, error],
    );
  } catch {
    // Never fail the health-check surface because the write-back failed.
  }
}
