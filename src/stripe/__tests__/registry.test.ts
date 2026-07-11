// Authorized by HUB-1781 (S8 of HUB-1773) — unit tests for the Stripe registry.
// Verifies mode caching, adapter routing, credential guard on LIVE flip, and
// non-fallback semantics (no implicit MOCK↔LIVE fallback).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppError } from '../../errors/AppError.js';

// Mock the settings-cache: getSetting throws AppError(404) unless we've called _setValue.
// This isolates the registry from Redis/PG and keeps these tests unit-level.
const settingsStore = new Map<string, unknown>();
vi.mock('../../settings/index.js', () => ({
  getSetting: vi.fn(async (key: string) => {
    if (settingsStore.has(key)) return settingsStore.get(key);
    throw new AppError(404, `Setting not found: ${key}`);
  }),
  invalidateSetting: vi.fn(async () => {}),
}));

// Mock the pool for seed + mode-flip writes.
const poolQueryMock = vi.fn(async () => ({ rows: [] }));
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: poolQueryMock }),
}));

// LiveStripeAdapter reaches for getStripe() at construction; stub it so the class can
// instantiate in this unit test (no real SDK boot).
vi.mock('../client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client.js')>();
  return {
    ...actual,
    getStripe: vi.fn(() => ({}) as unknown),
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  settingsStore.clear();
  const { _resetStripeRegistryForTest } = await import('../registry.js');
  _resetStripeRegistryForTest();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
  delete process.env.NODE_ENV;
});

afterEach(async () => {
  const { _resetStripeRegistryForTest } = await import('../registry.js');
  _resetStripeRegistryForTest();
});

describe('initStripeRegistry — bootstrap', () => {
  it('loads persisted mode from settings when present', async () => {
    settingsStore.set('stripe_connection_mode', { mode: 'mock' });
    const { initStripeRegistry, getStripeMode } = await import('../registry.js');
    await initStripeRegistry();
    expect(getStripeMode()).toBe('mock');
  });

  it('seeds default MOCK in non-production when setting is absent', async () => {
    const { initStripeRegistry, getStripeMode } = await import('../registry.js');
    await initStripeRegistry();
    expect(getStripeMode()).toBe('mock');
    expect(poolQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO settings'),
      expect.arrayContaining(['stripe_connection_mode', JSON.stringify({ mode: 'mock' })]),
    );
  });

  it('accepts persisted LIVE mode when credentials are present', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_x';
    settingsStore.set('stripe_connection_mode', { mode: 'live' });
    const { initStripeRegistry, getStripeMode } = await import('../registry.js');
    await initStripeRegistry();
    expect(getStripeMode()).toBe('live');
  });
});

describe('getStripeMode', () => {
  it('defaults to LIVE in non-production when called before init (legacy-test compat)', async () => {
    const { getStripeMode } = await import('../registry.js');
    expect(getStripeMode()).toBe('live');
  });

  it('throws in production when called before init', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const { getStripeMode } = await import('../registry.js');
      expect(() => getStripeMode()).toThrow(/not initialized/);
    } finally {
      delete process.env.NODE_ENV;
    }
  });
});

describe('getStripeConnection — adapter routing', () => {
  it('returns MockStripeAdapter when mode=mock', async () => {
    settingsStore.set('stripe_connection_mode', { mode: 'mock' });
    const { initStripeRegistry, getStripeConnection } = await import('../registry.js');
    const { MockStripeAdapter } = await import('../mockAdapter.js');
    await initStripeRegistry();
    expect(getStripeConnection()).toBeInstanceOf(MockStripeAdapter);
  });

  it('returns LiveStripeAdapter when mode=live', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_x';
    settingsStore.set('stripe_connection_mode', { mode: 'live' });
    const { initStripeRegistry, getStripeConnection } = await import('../registry.js');
    const { LiveStripeAdapter } = await import('../liveAdapter.js');
    await initStripeRegistry();
    expect(getStripeConnection()).toBeInstanceOf(LiveStripeAdapter);
  });

  it('returns the same adapter instance across calls (cached)', async () => {
    settingsStore.set('stripe_connection_mode', { mode: 'mock' });
    const { initStripeRegistry, getStripeConnection } = await import('../registry.js');
    await initStripeRegistry();
    const a = getStripeConnection();
    const b = getStripeConnection();
    expect(a).toBe(b);
  });
});

describe('setStripeMode', () => {
  it('rejects LIVE flip when credentials missing (writes nothing)', async () => {
    settingsStore.set('stripe_connection_mode', { mode: 'mock' });
    const { initStripeRegistry, setStripeMode, getStripeMode } = await import('../registry.js');
    await initStripeRegistry();
    const writeCallsBefore = poolQueryMock.mock.calls.length;
    await expect(setStripeMode('live', { operator_id: 'op-1' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('credentials missing') as unknown as string,
    });
    expect(getStripeMode()).toBe('mock');
    // Only the settings INSERT from setStripeMode should be absent; audit_log too.
    const newQueries = poolQueryMock.mock.calls.slice(writeCallsBefore);
    for (const [sql] of newQueries) {
      expect(sql).not.toContain('audit_log');
    }
  });

  it('allows mock → live when credentials present; updates in-process mode', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_x';
    settingsStore.set('stripe_connection_mode', { mode: 'mock' });
    const { initStripeRegistry, setStripeMode, getStripeMode } = await import('../registry.js');
    await initStripeRegistry();
    await setStripeMode('live', { operator_id: 'op-1' });
    expect(getStripeMode()).toBe('live');
  });

  it('allows live → mock unconditionally (credentials not required to drop LIVE)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_x';
    settingsStore.set('stripe_connection_mode', { mode: 'live' });
    const { initStripeRegistry, setStripeMode, getStripeMode } = await import('../registry.js');
    await initStripeRegistry();
    // Simulate credentials being removed at runtime; drop to mock should still succeed.
    delete process.env.STRIPE_SECRET_KEY;
    await setStripeMode('mock', { operator_id: 'op-1' });
    expect(getStripeMode()).toBe('mock');
  });

  it('writes an audit_log entry on successful flip', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_x';
    settingsStore.set('stripe_connection_mode', { mode: 'mock' });
    const { initStripeRegistry, setStripeMode } = await import('../registry.js');
    await initStripeRegistry();
    poolQueryMock.mockClear();
    await setStripeMode('live', { operator_id: 'op-1' });
    const auditCall = poolQueryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('audit_log'),
    );
    expect(auditCall).toBeDefined();
  });
});
