// Authorized by HUB-77 — ioredis singleton; REDIS_URL never logged; E3 adds BullMQ on top
// Authorized by HUB-125 — hub:* key prefix, exponential backoff retryStrategy, isRedisConnected()
// Authorized by HUB-1712 — getRedisClientForBullMQ() returns a dedicated ioredis client
//   with NO keyPrefix and maxRetriesPerRequest: null. BullMQ ≥5.x throws
//   "ioredis does not support ioredis prefixes, use the prefix option instead"
//   when handed a client with keyPrefix set. The main getRedisClient() keeps
//   keyPrefix: 'hub:' for all non-BullMQ Redis operations; BullMQ gets its own
//   client and uses its own prefix option (`prefix: 'hub:queue'`) to preserve
//   the same Redis key structure.
import { Redis } from 'ioredis';
import logger from '../lib/logger.js';

let _client: Redis | null = null;
let _bullmqClient: Redis | null = null;
// Per-client close signal — set by closeRedis() so retryStrategy stops reconnecting even
// after the module-level _client reference is cleared (ioredis fires retryStrategy
// asynchronously on socket close, after closeRedis() has already returned).
let _signalClose: (() => void) | null = null;
let _signalBullmqClose: (() => void) | null = null;

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

// BullMQ ≥5.x rejects ioredis clients that have `keyPrefix` set AND requires
// `maxRetriesPerRequest: null` on the connection it uses for its blocking commands
// (blpop/brpop). Returns a dedicated singleton that satisfies both constraints.
// BullMQ preserves the `hub:*` key namespace via its own `prefix: 'hub:queue'` option
// passed at Queue construction time (see queues/index.ts).
export function getRedisClientForBullMQ(): Redis {
  if (_bullmqClient) return _bullmqClient;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL environment variable is not set');

  let closing = false;
  _signalBullmqClose = () => { closing = true; };

  _bullmqClient = new Redis(url, {
    // No keyPrefix — BullMQ rejects clients that have one; prefix is applied per-Queue instead
    maxRetriesPerRequest: null,
    retryStrategy(times: number) {
      if (closing) return null;
      if (times > 5) {
        logger.error({ attempts: times }, 'Redis (BullMQ) connection failed after 5 attempts — aborting');
        if (process.env.NODE_ENV !== 'test') process.exit(1);
        return null;
      }
      const delay = Math.min(100 * 2 ** (times - 1), 1600);
      logger.warn({ attempt: times, delayMs: delay }, 'Redis (BullMQ) connection failed — retrying');
      return delay;
    },
  });

  _bullmqClient.on('error', () => {
    // Suppress unhandled error events — surfaces through queue-probe health check
  });

  _bullmqClient.on('reconnecting', () => {
    logger.info('Redis (BullMQ) reconnecting');
  });

  return _bullmqClient;
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
  if (_bullmqClient) {
    _signalBullmqClose?.();
    _signalBullmqClose = null;
    const clientToClose = _bullmqClient;
    _bullmqClient = null;
    try {
      await clientToClose.quit();
    } catch {
      clientToClose.disconnect();
    }
  }
}
