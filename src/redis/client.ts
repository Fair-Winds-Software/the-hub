// Authorized by HUB-77 — ioredis singleton; REDIS_URL never logged; E3 adds BullMQ on top
import { Redis } from 'ioredis';

let _client: Redis | null = null;

export function getRedisClient(): Redis {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL environment variable is not set');

  _client = new Redis(url, {
    // maxRetriesPerRequest:0 — commands fail immediately on error, no per-command retry loop.
    // enableOfflineQueue omitted (default: true) — commands queue during the initial connecting
    // phase so the first ping() in health checks doesn't reject mid-handshake.
    // The 2-second Promise.race timeout in health.ts is the fail-fast mechanism for down Redis.
    maxRetriesPerRequest: 0,
  });

  // Suppress unhandled error events; connection failures surface through ping() in health checks
  _client.on('error', () => {});

  return _client;
}

export async function closeRedis(): Promise<void> {
  if (_client) {
    try {
      await _client.quit();
    } catch {
      _client.disconnect();
    }
    _client = null;
  }
}
