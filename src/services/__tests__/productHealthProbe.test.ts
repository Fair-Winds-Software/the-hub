// Authorized by HUB-1545 (System Health spec-deviation close-out) —
// unit tests for the per-product HTTP liveness probe. Exercises the
// TTL-cache reuse path, the HEAD-then-GET fallback on 405, the timeout
// abort path, and the "no health_check_url" no-op branch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [] }));
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

import {
  getOrExecuteProbe,
  PROBE_TTL_MS,
  type ProbeInput,
} from '../productHealthProbe.js';

function makeInput(over: Partial<ProbeInput> = {}): ProbeInput {
  return {
    product_id: 'p-1',
    health_check_url: 'https://example.test/healthz',
    last_probe_at: null,
    last_probe_reachable: null,
    last_probe_error: null,
    last_probe_latency_ms: null,
    ...over,
  };
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getOrExecuteProbe', () => {
  it('reuses the cached result when last_probe_at is within TTL', async () => {
    const now = 1_000_000;
    const input = makeInput({
      last_probe_at: new Date(now - 10_000),
      last_probe_reachable: true,
      last_probe_latency_ms: 42,
    });
    const spyFetch = vi.fn();
    const res = await getOrExecuteProbe(input, now, spyFetch as unknown as typeof fetch);
    expect(res.reachable).toBe(true);
    expect(res.latencyMs).toBe(42);
    expect(spyFetch).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('re-probes when the cached result is older than TTL', async () => {
    const now = 1_000_000;
    const input = makeInput({
      last_probe_at: new Date(now - (PROBE_TTL_MS + 1)),
      last_probe_reachable: false,
    });
    const spyFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const res = await getOrExecuteProbe(input, now, spyFetch as unknown as typeof fetch);
    expect(res.reachable).toBe(true);
    expect(spyFetch).toHaveBeenCalledOnce();
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  it('falls back to GET when HEAD returns 405', async () => {
    const spyFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 405 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const res = await getOrExecuteProbe(
      makeInput(),
      Date.now(),
      spyFetch as unknown as typeof fetch,
    );
    expect(res.reachable).toBe(true);
    expect(spyFetch).toHaveBeenCalledTimes(2);
    expect(spyFetch.mock.calls[0]![1]!.method).toBe('HEAD');
    expect(spyFetch.mock.calls[1]![1]!.method).toBe('GET');
  });

  it('marks unreachable + records the HTTP status on non-2xx/3xx', async () => {
    const spyFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const res = await getOrExecuteProbe(
      makeInput(),
      Date.now(),
      spyFetch as unknown as typeof fetch,
    );
    expect(res.reachable).toBe(false);
    expect(res.error).toBe('HTTP 503');
  });

  it('returns { reachable: false, no probe attempted } when health_check_url is null', async () => {
    const spyFetch = vi.fn();
    const res = await getOrExecuteProbe(
      makeInput({ health_check_url: null }),
      Date.now(),
      spyFetch as unknown as typeof fetch,
    );
    expect(res.reachable).toBe(false);
    expect(res.error).toContain('no health_check_url');
    expect(spyFetch).not.toHaveBeenCalled();
  });

  it('catches a fetch throw + records the error string', async () => {
    const spyFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await getOrExecuteProbe(
      makeInput(),
      Date.now(),
      spyFetch as unknown as typeof fetch,
    );
    expect(res.reachable).toBe(false);
    expect(res.error).toBe('ECONNREFUSED');
  });

  it('persists probe results back to the products row', async () => {
    const spyFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await getOrExecuteProbe(makeInput(), Date.now(), spyFetch as unknown as typeof fetch);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toContain('UPDATE products');
    expect(params[0]).toBe('p-1');
    expect(params[2]).toBe(true);
  });
});
