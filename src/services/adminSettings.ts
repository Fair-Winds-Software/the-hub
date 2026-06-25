// Authorized by HUB-1060 — getSettings all (Redis SCAN/MGET first, DB fallback); updateSetting (DB upsert + Redis write)
// Authorized by HUB-1588 — getSetting(key) single-key Redis-first read (used by operatorRbac compat window check)
import { getPool } from '../db/pool.js';
import { getRedisClient, isRedisConnected } from '../redis/client.js';
import { AppError } from '../errors/AppError.js';

// ioredis keyPrefix='hub:' so actual Redis key = 'hub:settings:<key>'
// The prefix here is the suffix after keyPrefix.
const KEY_PREFIX = 'settings:';
const KEY_REGEX = /^[a-zA-Z0-9_]{1,100}$/;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export async function getSettings(): Promise<Record<string, JsonValue>> {
  if (isRedisConnected()) {
    try {
      const redis = getRedisClient();
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100);
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== '0');

      if (keys.length > 0) {
        const values = await redis.mget(...keys);
        const result: Record<string, JsonValue> = {};
        for (let i = 0; i < keys.length; i++) {
          const raw = values[i];
          if (raw !== null) {
            // ioredis SCAN returns keys WITH the keyPrefix ('hub:settings:<key>')
            const settingKey = keys[i]!.replace(/^hub:settings:/, '');
            result[settingKey] = JSON.parse(raw) as JsonValue;
          }
        }
        if (Object.keys(result).length > 0) return result;
      }
    } catch {
      // fall through to DB
    }
  }

  // DB fallback — also warms Redis cache on miss
  const { rows } = await getPool().query<{ key: string; value: JsonValue }>(
    `SELECT key, value FROM settings ORDER BY key`,
  );
  const result: Record<string, JsonValue> = {};
  for (const row of rows) {
    result[row.key] = row.value;
    if (isRedisConnected()) {
      try {
        await getRedisClient().set(`${KEY_PREFIX}${row.key}`, JSON.stringify(row.value));
      } catch {
        // ignore Redis write failure
      }
    }
  }
  return result;
}

/**
 * HUB-1588: single-key Redis-first read with DB fallback. Returns undefined when the key
 * is not present in either store (the caller decides fail-open vs fail-secure). Designed
 * for hot-path use (e.g., the operatorRbac compat-window flag check on every request);
 * Redis hit is sub-ms and DB miss is a single indexed lookup on (key UNIQUE).
 */
export async function getSetting(key: string): Promise<JsonValue | undefined> {
  if (!KEY_REGEX.test(key)) throw new AppError(400, 'Invalid setting key');

  if (isRedisConnected()) {
    try {
      const raw = await getRedisClient().get(`${KEY_PREFIX}${key}`);
      if (raw !== null) return JSON.parse(raw) as JsonValue;
    } catch {
      // fall through to DB
    }
  }

  const { rows } = await getPool().query<{ value: JsonValue }>(
    `SELECT value FROM settings WHERE key = $1`,
    [key],
  );
  const row = rows[0];
  if (!row) return undefined;

  if (isRedisConnected()) {
    try {
      await getRedisClient().set(`${KEY_PREFIX}${key}`, JSON.stringify(row.value));
    } catch {
      // ignore Redis write failure
    }
  }
  return row.value;
}

export async function updateSetting(
  key: string,
  value: JsonValue,
): Promise<{ key: string; value: JsonValue; updated_at: string }> {
  if (!KEY_REGEX.test(key)) throw new AppError(400, 'Invalid setting key');

  const pool = getPool();
  const { rows } = await pool.query<{ key: string; value: JsonValue; updated_at: string }>(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()
     RETURNING key, value, updated_at`,
    [key, JSON.stringify(value)],
  );

  const row = rows[0]!;

  if (isRedisConnected()) {
    try {
      await getRedisClient().set(`${KEY_PREFIX}${key}`, JSON.stringify(value));
    } catch {
      // ignore Redis write failure
    }
  }

  return row;
}
