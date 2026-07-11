// Authorized by HUB-1791 (S2 of HUB-1783) — unit tests for the multi-connection registry.
// Verifies registration, mode getter/setter, credential guard, missing-connection errors,
// audit_log emission on flip, and test hooks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppError } from '../../errors/AppError.js';
import type { ExternalConnection } from '../base.js';

const settingsStore = new Map<string, unknown>();
vi.mock('../../settings/index.js', () => ({
  getSetting: vi.fn(async (key: string) => {
    if (settingsStore.has(key)) return settingsStore.get(key);
    throw new AppError(404, `Setting not found: ${key}`);
  }),
  invalidateSetting: vi.fn(async () => {}),
}));

const poolQueryMock = vi.fn(async () => ({ rows: [] }));
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: poolQueryMock }),
}));

interface FakeConnection extends ExternalConnection {
  role: 'live' | 'mock';
}

function makeDescriptor(name: string, hasCreds: boolean) {
  return {
    name,
    buildLive: () => ({ name, role: 'live', mode: () => 'live', probe: async () => ({ health: 'ok', latency_ms: 0 }) } as unknown as FakeConnection),
    buildMock: () => ({ name, role: 'mock', mode: () => 'mock', probe: async () => ({ health: 'ok', latency_ms: 0 }) } as unknown as FakeConnection),
    hasLiveCredentials: () => hasCreds,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  settingsStore.clear();
  const { _resetConnectionsRegistryForTest } = await import('../registry.js');
  _resetConnectionsRegistryForTest();
  delete process.env.NODE_ENV;
});

afterEach(async () => {
  const { _resetConnectionsRegistryForTest } = await import('../registry.js');
  _resetConnectionsRegistryForTest();
});

describe('registerConnection + getConnection', () => {
  it('returns the mock adapter when mode=mock', async () => {
    const { registerConnection, initConnectionsRegistry, getConnection } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    settingsStore.set('connection_mode.stripe', { mode: 'mock' });
    await initConnectionsRegistry();
    const conn = getConnection<FakeConnection>('stripe');
    expect(conn.role).toBe('mock');
  });

  it('returns the live adapter when mode=live', async () => {
    const { registerConnection, initConnectionsRegistry, getConnection } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    settingsStore.set('connection_mode.stripe', { mode: 'live' });
    await initConnectionsRegistry();
    const conn = getConnection<FakeConnection>('stripe');
    expect(conn.role).toBe('live');
  });

  it('caches the adapter instance across calls', async () => {
    const { registerConnection, initConnectionsRegistry, getConnection } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    settingsStore.set('connection_mode.stripe', { mode: 'mock' });
    await initConnectionsRegistry();
    const a = getConnection('stripe');
    const b = getConnection('stripe');
    expect(a).toBe(b);
  });

  it('throws AppError(404) when the connection is not registered', async () => {
    const { getConnection } = await import('../registry.js');
    expect(() => getConnection('does-not-exist')).toThrow(/Unknown connection/);
  });
});

describe('initConnectionsRegistry — bootstrap', () => {
  it('loads persisted mode from settings for each registered connection', async () => {
    const { registerConnection, initConnectionsRegistry, getConnectionMode } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    registerConnection(makeDescriptor('ga', true));
    settingsStore.set('connection_mode.stripe', { mode: 'live' });
    settingsStore.set('connection_mode.ga', { mode: 'mock' });
    await initConnectionsRegistry();
    expect(getConnectionMode('stripe')).toBe('live');
    expect(getConnectionMode('ga')).toBe('mock');
  });

  it('seeds default MOCK in non-production when setting is absent', async () => {
    const { registerConnection, initConnectionsRegistry, getConnectionMode } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    await initConnectionsRegistry();
    expect(getConnectionMode('stripe')).toBe('mock');
    expect(poolQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO settings'),
      expect.arrayContaining(['connection_mode.stripe', JSON.stringify({ mode: 'mock' })]),
    );
  });
});

describe('setConnectionMode', () => {
  it('rejects LIVE flip when credentials missing (writes nothing)', async () => {
    const { registerConnection, initConnectionsRegistry, setConnectionMode, getConnectionMode } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', false));
    settingsStore.set('connection_mode.stripe', { mode: 'mock' });
    await initConnectionsRegistry();
    poolQueryMock.mockClear();
    await expect(setConnectionMode('stripe', 'live', { operator_id: 'op-1' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('credentials missing') as unknown as string,
    });
    expect(getConnectionMode('stripe')).toBe('mock');
    for (const [sql] of poolQueryMock.mock.calls) {
      expect(sql).not.toContain('audit_log');
    }
  });

  it('allows mock → live when credentials present; updates mode', async () => {
    const { registerConnection, initConnectionsRegistry, setConnectionMode, getConnectionMode } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    settingsStore.set('connection_mode.stripe', { mode: 'mock' });
    await initConnectionsRegistry();
    await setConnectionMode('stripe', 'live', { operator_id: 'op-1' });
    expect(getConnectionMode('stripe')).toBe('live');
  });

  it('writes an audit_log entry (operation = <name>.mode_change) on successful flip', async () => {
    const { registerConnection, initConnectionsRegistry, setConnectionMode } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    settingsStore.set('connection_mode.stripe', { mode: 'mock' });
    await initConnectionsRegistry();
    poolQueryMock.mockClear();
    await setConnectionMode('stripe', 'live', { operator_id: 'op-1' });
    const auditCall = poolQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('audit_log'),
    );
    expect(auditCall).toBeDefined();
    // Verify the operation label is namespaced by connection name.
    const args = auditCall![1] as unknown[];
    expect(args).toContain('stripe.mode_change');
  });
});

describe('listConnections', () => {
  it('returns snapshot of every registered connection', async () => {
    const { registerConnection, initConnectionsRegistry, listConnections } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    registerConnection(makeDescriptor('ga', true));
    settingsStore.set('connection_mode.stripe', { mode: 'live' });
    settingsStore.set('connection_mode.ga', { mode: 'mock' });
    await initConnectionsRegistry();
    const list = listConnections();
    expect(list).toHaveLength(2);
    const stripe = list.find((c) => c.name === 'stripe');
    const ga = list.find((c) => c.name === 'ga');
    expect(stripe?.mode).toBe('live');
    expect(ga?.mode).toBe('mock');
  });

  it('returns [] when nothing is registered', async () => {
    const { listConnections } = await import('../registry.js');
    expect(listConnections()).toEqual([]);
  });
});

describe('test hooks', () => {
  it('_setConnectionModeForTest forces a mode without touching PG', async () => {
    const { registerConnection, _setConnectionModeForTest, getConnectionMode } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    _setConnectionModeForTest('stripe', 'live');
    expect(getConnectionMode('stripe')).toBe('live');
  });

  it('_resetConnectionInstancesForTest drops adapter cache but keeps registration', async () => {
    const { registerConnection, initConnectionsRegistry, getConnection, _resetConnectionInstancesForTest, _setConnectionModeForTest } = await import('../registry.js');
    registerConnection(makeDescriptor('stripe', true));
    settingsStore.set('connection_mode.stripe', { mode: 'mock' });
    await initConnectionsRegistry();
    const a = getConnection('stripe');
    _resetConnectionInstancesForTest('stripe');
    _setConnectionModeForTest('stripe', 'mock');
    const b = getConnection('stripe');
    expect(a).not.toBe(b);
  });
});
