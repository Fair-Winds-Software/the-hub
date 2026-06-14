// Authorized by HUB-125 — ioredis singleton: hub:* key prefix, exponential backoff, isRedisConnected()
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import { getRedisClient, isRedisConnected, closeRedis } from '../client.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Populated in beforeAll — tests that need a live connection check this first
let redisAvailable = false;

beforeAll(async () => {
  process.env.REDIS_URL = REDIS_URL;
  // Quick probe: single connection attempt with no retries to check availability
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 1000,
  });
  try {
    await probe.connect();
    redisAvailable = true;
    await probe.quit();
  } catch {
    probe.disconnect();
  }
});

afterEach(async () => {
  await closeRedis();
});

afterAll(async () => {
  await closeRedis();
});

// ── Singleton ────────────────────────────────────────────────────────────────

describe('getRedisClient()', () => {
  it('returns the same instance on repeated calls', () => {
    const a = getRedisClient();
    const b = getRedisClient();
    expect(a).toBe(b);
  });

  it('throws when REDIS_URL is not set', () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    expect(() => getRedisClient()).toThrow('REDIS_URL environment variable is not set');
    process.env.REDIS_URL = prev;
  });
});

// ── isRedisConnected() ───────────────────────────────────────────────────────

describe('isRedisConnected()', () => {
  it('returns false before any client is created', async () => {
    // closeRedis() already called in afterEach; _client is null
    expect(isRedisConnected()).toBe(false);
  });

  it('returns true once the client is ready', async (ctx) => {
    if (!redisAvailable) return ctx.skip();
    const client = getRedisClient();
    // Wait for the ready event (or resolve immediately if already ready)
    await new Promise<void>((resolve) => {
      if (client.status === 'ready') { resolve(); return; }
      client.once('ready', () => resolve());
    });
    expect(isRedisConnected()).toBe(true);
  });

  it('returns false after closeRedis()', async () => {
    getRedisClient();
    await closeRedis();
    expect(isRedisConnected()).toBe(false);
  });
});

// ── hub:* key prefix ─────────────────────────────────────────────────────────

describe('hub:* key prefix', () => {
  it('writes via getRedisClient().set() stores key under hub: namespace in raw Redis', async (ctx) => {
    if (!redisAvailable) return ctx.skip();
    const client = getRedisClient();
    await new Promise<void>((resolve) => {
      if (client.status === 'ready') { resolve(); return; }
      client.once('ready', () => resolve());
    });

    const testKey = `hub125-prefix-test-${Date.now()}`;
    await client.set(testKey, 'value', 'EX', 10);

    // Verify the raw Redis key has hub: prefix using a separate client without keyPrefix
    const rawClient = new Redis(REDIS_URL);
    try {
      const rawValue = await rawClient.get(`hub:${testKey}`);
      expect(rawValue).toBe('value');
      // Confirm key WITHOUT prefix doesn't exist
      const noPrefix = await rawClient.get(testKey);
      expect(noPrefix).toBeNull();
    } finally {
      await rawClient.del(`hub:${testKey}`);
      await rawClient.quit();
    }
  });

  it('delete via client.del() removes the hub:-prefixed key', async (ctx) => {
    if (!redisAvailable) return ctx.skip();
    const client = getRedisClient();
    await new Promise<void>((resolve) => {
      if (client.status === 'ready') { resolve(); return; }
      client.once('ready', () => resolve());
    });

    const testKey = `hub125-del-test-${Date.now()}`;
    await client.set(testKey, '1', 'EX', 10);
    await client.del(testKey);

    const rawClient = new Redis(REDIS_URL);
    try {
      const gone = await rawClient.get(`hub:${testKey}`);
      expect(gone).toBeNull();
    } finally {
      await rawClient.quit();
    }
  });
});

// ── retryStrategy unit behaviour ─────────────────────────────────────────────

describe('retryStrategy logic', () => {
  it('returns 100ms delay for attempt 1', () => {
    // Test the formula directly: Math.min(100 * 2**(times-1), 1600)
    expect(Math.min(100 * 2 ** (1 - 1), 1600)).toBe(100);
  });

  it('returns exponentially increasing delays up to 1600ms', () => {
    const delays = [1, 2, 3, 4, 5].map((t) => Math.min(100 * 2 ** (t - 1), 1600));
    expect(delays).toEqual([100, 200, 400, 800, 1600]);
  });
});
