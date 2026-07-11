// Authorized by HUB-1793 (S4 of HUB-1783) — tests for the generic /connections/:name/*
// routes and the list endpoint. The /stripe/* alias tests live in connections.test.ts
// (unchanged from HUB-1782 / S9); those verify backward compat. This file verifies the
// new generic path works for any registered connection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExternalConnection } from '../../../connections/base.js';

// Mock the settings-cache: the generic registry consults it during init.
const settingsStore = new Map<string, unknown>();
vi.mock('../../../settings/index.js', () => ({
  getSetting: vi.fn(async (key: string) => {
    if (settingsStore.has(key)) return settingsStore.get(key);
    throw Object.assign(new Error(`Setting not found: ${key}`), { statusCode: 404 });
  }),
  invalidateSetting: vi.fn(async () => {}),
}));

const poolQueryMock = vi.fn(async () => ({ rows: [] }));
vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: poolQueryMock }),
}));

// Also mock the Stripe-specific registry so the alias tests coexisting in the harness
// don't blow up during import.
vi.mock('../../../stripe/registry.js', () => ({
  getStripeMode: () => 'mock',
  setStripeMode: async () => {},
  getStripeConnection: () => ({ balance: { retrieve: async () => ({}) } }),
}));

async function buildHarness() {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../connections.js')).default;
  const { AppError } = await import('../../../errors/AppError.js');
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: err.message });
  });
  await app.register(routes);
  return app;
}

function makeFake(name: string, mode: 'live' | 'mock'): ExternalConnection {
  return {
    name,
    mode: () => mode,
    probe: async () => ({ health: 'ok', latency_ms: 0 }),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  settingsStore.clear();
  const { _resetConnectionsRegistryForTest } = await import('../../../connections/registry.js');
  _resetConnectionsRegistryForTest();
  const { _resetStatusCacheForTest } = await import('../../../connections/probe.js');
  _resetStatusCacheForTest();
});

afterEach(async () => {
  const { _resetConnectionsRegistryForTest } = await import('../../../connections/registry.js');
  _resetConnectionsRegistryForTest();
});

describe('GET /api/v1/admin/connections (list)', () => {
  it('returns [] when nothing is registered', async () => {
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ connections: [] });
    await app.close();
  });

  it('returns one entry per registered connection', async () => {
    const { registerConnection, initConnectionsRegistry } = await import('../../../connections/registry.js');
    registerConnection({
      name: 'ga',
      buildLive: () => makeFake('ga', 'live'),
      buildMock: () => makeFake('ga', 'mock'),
      hasLiveCredentials: () => true,
    });
    settingsStore.set('connection_mode.ga', { mode: 'mock' });
    await initConnectionsRegistry();

    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections' });
    const body = JSON.parse(res.body) as { connections: Array<{ name: string; mode: string }> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]!.name).toBe('ga');
    expect(body.connections[0]!.mode).toBe('mock');
    await app.close();
  });
});

describe('GET /api/v1/admin/connections/:name/mode', () => {
  it('returns the mode for a registered connection', async () => {
    const { registerConnection, initConnectionsRegistry } = await import('../../../connections/registry.js');
    registerConnection({
      name: 'ga',
      buildLive: () => makeFake('ga', 'live'),
      buildMock: () => makeFake('ga', 'mock'),
      hasLiveCredentials: () => true,
    });
    settingsStore.set('connection_mode.ga', { mode: 'live' });
    await initConnectionsRegistry();

    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/ga/mode' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mode: 'live' });
    await app.close();
  });

  it('returns 404 for an unregistered connection', async () => {
    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/does-not-exist/mode' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/v1/admin/connections/:name/status', () => {
  it('returns mock + ok when mode=mock (no probe invoked)', async () => {
    const probeSpy = vi.fn(async () => ({ health: 'ok' as const, latency_ms: 0 }));
    const { registerConnection, initConnectionsRegistry } = await import('../../../connections/registry.js');
    registerConnection({
      name: 'ga',
      buildLive: () => ({ name: 'ga', mode: () => 'live', probe: probeSpy } as ExternalConnection),
      buildMock: () => ({ name: 'ga', mode: () => 'mock', probe: probeSpy } as ExternalConnection),
      hasLiveCredentials: () => true,
    });
    settingsStore.set('connection_mode.ga', { mode: 'mock' });
    await initConnectionsRegistry();

    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/ga/status' });
    const body = JSON.parse(res.body) as { name: string; mode: string; health: string; latency_ms: number };
    expect(body.name).toBe('ga');
    expect(body.mode).toBe('mock');
    expect(body.health).toBe('ok');
    expect(body.latency_ms).toBe(0);
    expect(probeSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('invokes adapter.probe() when mode=live and returns ok on success', async () => {
    const probeSpy = vi.fn(async () => undefined);
    const { registerConnection, initConnectionsRegistry } = await import('../../../connections/registry.js');
    registerConnection({
      name: 'ga',
      buildLive: () => ({
        name: 'ga',
        mode: () => 'live',
        probe: probeSpy,
      } as unknown as ExternalConnection),
      buildMock: () => ({ name: 'ga', mode: () => 'mock', probe: probeSpy } as unknown as ExternalConnection),
      hasLiveCredentials: () => true,
    });
    settingsStore.set('connection_mode.ga', { mode: 'live' });
    await initConnectionsRegistry();

    const app = await buildHarness();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/connections/ga/status' });
    const body = JSON.parse(res.body) as { mode: string; health: string };
    expect(body.mode).toBe('live');
    expect(body.health).toBe('ok');
    expect(probeSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('PUT /api/v1/admin/connections/:name/mode', () => {
  it('flips mode and returns the target', async () => {
    const { registerConnection, initConnectionsRegistry, getConnectionMode } = await import('../../../connections/registry.js');
    registerConnection({
      name: 'ga',
      buildLive: () => makeFake('ga', 'live'),
      buildMock: () => makeFake('ga', 'mock'),
      hasLiveCredentials: () => true,
    });
    settingsStore.set('connection_mode.ga', { mode: 'mock' });
    await initConnectionsRegistry();

    const app = await buildHarness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/connections/ga/mode',
      payload: { mode: 'live' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mode: 'live' });
    expect(getConnectionMode('ga')).toBe('live');
    await app.close();
  });

  it('rejects unknown mode value', async () => {
    const { registerConnection, initConnectionsRegistry } = await import('../../../connections/registry.js');
    registerConnection({
      name: 'ga',
      buildLive: () => makeFake('ga', 'live'),
      buildMock: () => makeFake('ga', 'mock'),
      hasLiveCredentials: () => true,
    });
    settingsStore.set('connection_mode.ga', { mode: 'mock' });
    await initConnectionsRegistry();

    const app = await buildHarness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/connections/ga/mode',
      payload: { mode: 'nonsense' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
