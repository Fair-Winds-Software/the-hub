// Authorized by HUB-160 — Redis-backed settings cache; pub/sub invalidation; PostgreSQL fallback
import { Redis } from 'ioredis';
import { getRedisClient, isRedisConnected } from '../redis/client.js';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// Pub/sub channel for cache invalidation — not a Redis key, so keyPrefix does not apply
const INVALIDATE_CHANNEL = 'hub:settings:invalidate';

// Key prefix within the ioredis keyPrefix namespace (hub: is added automatically)
// Resulting actual Redis key: hub:settings:<key>
const KEY_PREFIX = 'settings:';

// Dedicated subscriber connection — pub/sub mode blocks the connection for other commands
let _subscriber: Redis | null = null;

function makeSubscriberClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL environment variable is not set');
  const sub = new Redis(url, {
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  sub.on('error', () => {});
  return sub;
}

async function loadFromPostgres(key: string): Promise<JsonValue | null> {
  const { rows } = await getPool().query<{ value: JsonValue }>(
    'SELECT value FROM settings WHERE key = $1',
    [key],
  );
  return rows.length > 0 ? rows[0].value : null;
}

export async function getSetting(key: string): Promise<JsonValue> {
  const cacheKey = `${KEY_PREFIX}${key}`;

  if (isRedisConnected()) {
    try {
      const raw = await getRedisClient().get(cacheKey);
      if (raw !== null) {
        return JSON.parse(raw) as JsonValue;
      }
    } catch (err) {
      logger.warn({ key }, 'Redis read failed — falling back to PostgreSQL');
    }
  } else {
    logger.warn({ key }, 'Redis unavailable — falling back to PostgreSQL for settings read');
  }

  // Cache miss or Redis unavailable
  const value = await loadFromPostgres(key);
  if (value === null) {
    throw new AppError(404, `Setting not found: ${key}`);
  }

  // Warm cache when Redis is available
  if (isRedisConnected()) {
    try {
      await getRedisClient().set(cacheKey, JSON.stringify(value));
    } catch {
      logger.warn({ key }, 'Failed to warm settings cache');
    }
  }

  return value;
}

export async function invalidateSetting(key: string): Promise<void> {
  if (!isRedisConnected()) return;
  const cacheKey = `${KEY_PREFIX}${key}`;
  try {
    await getRedisClient().del(cacheKey);
    await getRedisClient().publish(INVALIDATE_CHANNEL, key);
    logger.info({ key }, 'Setting cache invalidated');
  } catch {
    logger.warn({ key }, 'Failed to publish settings invalidation');
  }
}

export async function startSettingsSubscriber(): Promise<void> {
  if (_subscriber) return;
  const sub = makeSubscriberClient();

  try {
    await sub.connect();
  } catch {
    logger.warn('Redis unavailable — settings pub/sub subscriber not started');
    return;
  }

  _subscriber = sub;
  await _subscriber.subscribe(INVALIDATE_CHANNEL);
  logger.info({ channel: INVALIDATE_CHANNEL }, 'Settings invalidation subscriber ready');

  _subscriber.on('message', async (_channel: string, key: string) => {
    const cacheKey = `${KEY_PREFIX}${key}`;
    logger.info({ key }, 'Settings invalidation received — evicting and re-warming cache');
    try {
      if (isRedisConnected()) {
        await getRedisClient().del(cacheKey);
      }
      const value = await loadFromPostgres(key);
      if (value !== null && isRedisConnected()) {
        await getRedisClient().set(cacheKey, JSON.stringify(value));
        logger.info({ key }, 'Settings cache re-warmed after invalidation');
      }
    } catch {
      logger.warn({ key }, 'Failed to re-warm settings cache after invalidation');
    }
  });
}

export async function stopSettingsSubscriber(): Promise<void> {
  if (_subscriber) {
    await _subscriber.quit().catch(() => _subscriber?.disconnect());
    _subscriber = null;
  }
}
