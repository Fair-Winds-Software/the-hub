// Authorized by HUB-1782 (S9 of HUB-1773) — unit tests for the connections routes.
// Verifies the /status endpoint returns the correct shape per mode, the health probe
// classifies rate-limit as degraded vs. other errors as down, and the 15s cache
// short-circuits repeat calls within TTL + invalidates on mode change.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppError } from '../../../errors/AppError.js';

// Mock the registry so we control mode + adapter without a full app boot.
const mockGetStripeMode = vi.hoisted(() => vi.fn());
const mockBalanceRetrieve = vi.hoisted(() => vi.fn());
const mockSetStripeMode = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../../stripe/registry.js', () => ({
  getStripeMode: mockGetStripeMode,
  setStripeMode: mockSetStripeMode,
  getStripeConnection: () => ({ balance: { retrieve: mockBalanceRetrieve } }),
}));

// Build a Fastify shim harness. We import the plugin lazily inside each test after
// resetting the module-level cache.
async function buildHarness() {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../connections.js')).default;
  const app = Fastify();
  await app.register(routes);
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../connections.js');
  mod._resetStripeStatusCacheForTest();
});

afterEach(async () => {
  const mod = await import('../connections.js');
  mod._resetStripeStatusCacheForTest();
});

describe('GET /api/v1/admin/connections/stripe/status', () => {
  it('returns mock + ok when mode=mock (no probe invoked)', async () => {
    mockGetStripeMode.mockReturnValue('mock');
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { mode: string; health: string; latency_ms: number };
    expect(body.mode).toBe('mock');
    expect(body.health).toBe('ok');
    expect(body.latency_ms).toBe(0);
    expect(mockBalanceRetrieve).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns live + ok when the probe succeeds', async () => {
    mockGetStripeMode.mockReturnValue('live');
    mockBalanceRetrieve.mockResolvedValueOnce({});
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    const body = JSON.parse(res.body) as { mode: string; health: string; reason?: string };
    expect(body.mode).toBe('live');
    expect(body.health).toBe('ok');
    expect(body.reason).toBeUndefined();
    await app.close();
  });

  it('returns live + degraded when the probe throws a rate-limit-like error', async () => {
    mockGetStripeMode.mockReturnValue('live');
    mockBalanceRetrieve.mockRejectedValueOnce(new Error('rate_limit exceeded'));
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    const body = JSON.parse(res.body) as { mode: string; health: string; reason: string };
    expect(body.mode).toBe('live');
    expect(body.health).toBe('degraded');
    expect(body.reason).toContain('rate_limit');
    await app.close();
  });

  it('returns live + down when the probe throws a generic error', async () => {
    mockGetStripeMode.mockReturnValue('live');
    mockBalanceRetrieve.mockRejectedValueOnce(new Error('network unreachable'));
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    const body = JSON.parse(res.body) as { mode: string; health: string; reason: string };
    expect(body.mode).toBe('live');
    expect(body.health).toBe('down');
    expect(body.reason).toContain('network unreachable');
    await app.close();
  });

  it('caches within 15s TTL and short-circuits repeat calls', async () => {
    mockGetStripeMode.mockReturnValue('live');
    mockBalanceRetrieve.mockResolvedValueOnce({});
    const app = await buildHarness();
    await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    // Probe invoked ONCE despite 3 requests.
    expect(mockBalanceRetrieve).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('mode flip invalidates the cache', async () => {
    mockGetStripeMode.mockReturnValue('live');
    mockBalanceRetrieve.mockResolvedValueOnce({});
    const app = await buildHarness();
    await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    expect(mockBalanceRetrieve).toHaveBeenCalledTimes(1);

    // Simulate a mode flip: registry now returns 'mock'.
    mockGetStripeMode.mockReturnValue('mock');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/status' });
    const body = JSON.parse(res.body) as { mode: string; health: string };
    expect(body.mode).toBe('mock');
    expect(body.health).toBe('ok');
    // Mock probe never invoked — probe only runs for live mode. Live probe count unchanged.
    expect(mockBalanceRetrieve).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('GET /api/v1/admin/connections/stripe/mode', () => {
  it('returns the current mode', async () => {
    mockGetStripeMode.mockReturnValue('mock');
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/stripe/mode' });
    expect(JSON.parse(res.body)).toEqual({ mode: 'mock' });
    await app.close();
  });
});

describe('PUT /api/v1/admin/connections/stripe/mode', () => {
  it('accepts a valid mode and delegates to setStripeMode', async () => {
    mockGetStripeMode.mockReturnValue('mock');
    const app = await buildHarness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/connections/stripe/mode',
      payload: { mode: 'mock' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mode: 'mock' });
    expect(mockSetStripeMode).toHaveBeenCalledWith('mock', expect.objectContaining({ actor_type: 'operator' }));
    await app.close();
  });

  it('rejects an unknown mode value', async () => {
    mockGetStripeMode.mockReturnValue('mock');
    const app = await buildHarness();
    // Attach an error handler so AppError renders as JSON with the statusCode.
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
      return reply.status(500).send({ error: err.message });
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/connections/stripe/mode',
      payload: { mode: 'not-real' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSetStripeMode).not.toHaveBeenCalled();
    await app.close();
  });
});
