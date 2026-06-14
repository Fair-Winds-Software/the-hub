// Authorized by HUB-77 — ioredis singleton; REDIS_URL never logged; E3 adds BullMQ on top
// Authorized by HUB-125 — hub:* key prefix, exponential backoff retryStrategy, isRedisConnected()
import { Redis } from 'ioredis';
import logger from '../lib/logger.js';

let _client: Redis | null = null;
// Per-client close signal — set by closeRedis() so retryStrategy stops reconnecting even
// after the module-level _client reference is cleared (ioredis fires retryStrategy
// asynchronously on socket close, after closeRedis() has already returned).
let _signalClose: (() => void) | null = null;

export function getRedisClient(): Redis {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL environment variable is not set');

  // Closure variable captured per-client — survives after _client is set to null
  let closing = false;
  _signalClose = () => { closing = true; };

  _client = new Redis(url, {
    // hub:* key namespace — all consumers share one prefix; no caller adds it manually
    keyPrefix: 'hub:',
    // Per-command retries disabled — commands fail immediately on error.
    // Connection-level reconnection is handled by retryStrategy below.
    maxRetriesPerRequest: 0,
    retryStrategy(times: number) {
      // Intentional close via closeRedis() — stop reconnecting immediately
      if (closing) return null;
      if (times > 5) {
        logger.error({ attempts: times }, 'Redis connection failed after 5 attempts — aborting');
        // In test environments Vitest intercepts process.exit as an uncaught exception
        // and disrupts unrelated test files. Return null to stop retrying instead.
        if (process.env.NODE_ENV !== 'test') process.exit(1);
        return null;
      }
      const delay = Math.min(100 * 2 ** (times - 1), 1600);
      logger.warn({ attempt: times, delayMs: delay }, 'Redis connection failed — retrying');
      return delay;
    },
  });

  _client.on('error', () => {
    // Suppress unhandled error events — connection failures surface through health checks
  });

  _client.on('reconnecting', () => {
    logger.info('Redis reconnecting');
  });

  return _client;
}

export function isRedisConnected(): boolean {
  if (!_client) return false;
  return _client.status === 'ready';
}

export async function closeRedis(): Promise<void> {
  if (_client) {
    // Signal this client's retryStrategy before clearing module refs so async
    // socket-close events (fired after quit() resolves) still see closing=true.
    _signalClose?.();
    _signalClose = null;
    const clientToClose = _client;
    _client = null;
    try {
      await clientToClose.quit();
    } catch {
      clientToClose.disconnect();
    }
  }
}
