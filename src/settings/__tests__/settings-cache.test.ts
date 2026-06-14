// Authorized by HUB-160 — unit tests for Redis-backed settings cache
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock ioredis (subscriber connection) ──────────────────────────────────────
const mockSubscribe = vi.fn().mockResolvedValue(undefined);
const mockSubscriberOn = vi.fn();
const mockSubscriberConnect = vi.fn().mockResolvedValue(undefined);
const mockSubscriberQuit = vi.fn().mockResolvedValue(undefined);

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    on: mockSubscriberOn,
    connect: mockSubscriberConnect,
    subscribe: mockSubscribe,
    quit: mockSubscriberQuit,
    disconnect: vi.fn(),
  })),
}));

// ── Mock Redis singleton (standard client) ────────────────────────────────────
const mockGet = vi.fn();
const mockSet = vi.fn().mockResolvedValue('OK');
const mockDel = vi.fn().mockResolvedValue(1);
const mockPublish = vi.fn().mockResolvedValue(1);

let _redisConnected = true;
vi.mock('../../redis/client.js', () => ({
  getRedisClient: vi.fn(() => ({ get: mockGet, set: mockSet, del: mockDel, publish: mockPublish })),
  isRedisConnected: vi.fn(() => _redisConnected),
}));

// ── Mock PostgreSQL pool ──────────────────────────────────────────────────────
const mockQuery = vi.fn();
vi.mock('../../db/pool.js', () => ({
  getPool: vi.fn(() => ({ query: mockQuery })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  _redisConnected = true;
  mockGet.mockResolvedValue(null);
  mockQuery.mockResolvedValue({ rows: [] });
});

// ── getSetting ────────────────────────────────────────────────────────────────

describe('getSetting()', () => {
  it('returns cached value from Redis on second call without hitting PostgreSQL', async () => {
    mockGet.mockResolvedValueOnce(JSON.stringify({ enabled: true }));

    const { getSetting } = await import('../index.js');
    const result = await getSetting('feature-flag');

    expect(result).toEqual({ enabled: true });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reads from PostgreSQL on cache miss and warms the cache', async () => {
    mockGet.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [{ value: 'enabled' }] });

    const { getSetting } = await import('../index.js');
    const result = await getSetting('mode');

    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT value FROM settings WHERE key = $1',
      ['mode'],
    );
    expect(mockSet).toHaveBeenCalledWith('settings:mode', JSON.stringify('enabled'));
    expect(result).toBe('enabled');
  });

  it('throws AppError(404) when key absent from both Redis and PostgreSQL', async () => {
    const { getSetting } = await import('../index.js');
    await expect(getSetting('missing-key')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mockQuery).toHaveBeenCalled();
  });

  it('falls back to PostgreSQL when Redis is unavailable, emits warn, does not throw', async () => {
    _redisConnected = false;
    mockQuery.mockResolvedValue({ rows: [{ value: 42 }] });

    const { getSetting } = await import('../index.js');
    const result = await getSetting('rate-limit');

    expect(result).toBe(42);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('falls back to PostgreSQL when Redis GET throws, does not throw', async () => {
    mockGet.mockRejectedValue(new Error('Redis error'));
    mockQuery.mockResolvedValue({ rows: [{ value: 'ok' }] });

    const { getSetting } = await import('../index.js');
    const result = await getSetting('setting-x');

    expect(result).toBe('ok');
    expect(mockQuery).toHaveBeenCalled();
  });
});

// ── invalidateSetting ─────────────────────────────────────────────────────────

describe('invalidateSetting()', () => {
  it('DELs the cache key and publishes to the invalidation channel', async () => {
    const { invalidateSetting } = await import('../index.js');
    await invalidateSetting('maintenance-mode');

    expect(mockDel).toHaveBeenCalledWith('settings:maintenance-mode');
    expect(mockPublish).toHaveBeenCalledWith('hub:settings:invalidate', 'maintenance-mode');
  });

  it('is a no-op when Redis is unavailable', async () => {
    _redisConnected = false;

    const { invalidateSetting } = await import('../index.js');
    await invalidateSetting('some-key');

    expect(mockDel).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
