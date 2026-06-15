// Authorized by HUB-629 — POST /api/v1/usage/events; service auth via x-client-id/x-client-secret; per-clientId rate limit
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';
import { getRedisClient } from '../redis/client.js';
import { AppError } from '../errors/AppError.js';
import { recordUsageEvent } from '../services/usageTrackingService.js';
import logger from '../lib/logger.js';

// TODO-D-DEF-002: Rate limiting for usage route is per-clientId, using Redis INCR+PEXPIRE.
// Window and max are env-configurable (USAGE_RATE_LIMIT_WINDOW_MS, USAGE_RATE_LIMIT_MAX).
// Current implementation fails open on Redis error to preserve event ingestion.
const USAGE_RL_MAX = parseInt(process.env.USAGE_RATE_LIMIT_MAX ?? '1000', 10);
const USAGE_RL_WINDOW_MS = parseInt(process.env.USAGE_RATE_LIMIT_WINDOW_MS ?? '60000', 10);

const usageRoutes: FastifyPluginAsync = async (fastify) => {
  const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
  const DUMMY_HASH = await bcrypt.hash('__hub_usage_dummy__', BCRYPT_ROUNDS);

  // POST /api/v1/usage/events — batch usage event ingestion
  // Auth: x-client-id + x-client-secret headers (service credentials, no JWT)
  // Rate limit: per clientId, Redis INCR+PEXPIRE, fail-open on Redis error
  fastify.post(
    '/api/v1/usage/events',
    async (request, reply) => {
      // ── Service auth ────────────────────────────────────────────────────────
      const clientId = request.headers['x-client-id'];
      const clientSecret = request.headers['x-client-secret'];

      if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
        throw new AppError(401, 'Missing x-client-id or x-client-secret headers');
      }

      const { rows } = await getPool().query<{
        product_id: string;
        tenant_id: string;
        client_secret_hash: string;
      }>(
        `SELECT pr.product_id, p.tenant_id, pr.client_secret_hash
           FROM product_registrations pr
           JOIN products p ON p.id = pr.product_id
          WHERE pr.client_id = $1`,
        [clientId],
      );

      const row = rows[0];
      const valid = await bcrypt.compare(clientSecret, row?.client_secret_hash ?? DUMMY_HASH);

      if (!row || !valid) {
        throw new AppError(401, 'Invalid credentials');
      }

      const { tenant_id: tenantId, product_id: productId } = row;

      // ── Rate limiting ───────────────────────────────────────────────────────
      try {
        const redis = getRedisClient();
        const rlKey = `hub:ratelimit:usage:${clientId}`;
        const count = await redis.incr(rlKey);
        if (count === 1) {
          await redis.pexpire(rlKey, USAGE_RL_WINDOW_MS);
        }
        if (count > USAGE_RL_MAX) {
          const ttlMs = await redis.pttl(rlKey);
          const retryAfter = Math.ceil(Math.max(ttlMs, 0) / 1000);
          reply.header('Retry-After', String(retryAfter));
          throw new AppError(429, 'Usage rate limit exceeded');
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.warn({ err, clientId }, 'Redis rate-limit check failed — failing open');
      }

      // ── Validate body ───────────────────────────────────────────────────────
      const body = request.body as Record<string, unknown> | null;
      if (!body || !Array.isArray(body.events) || body.events.length === 0) {
        throw new AppError(400, 'events must be a non-empty array');
      }

      const events = body.events as Array<Record<string, unknown>>;

      for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        if (typeof e.event_type !== 'string') {
          throw new AppError(400, `events[${i}].event_type is required and must be a string`);
        }
        if (typeof e.unit_count !== 'number' || !Number.isInteger(e.unit_count) || e.unit_count < 1) {
          throw new AppError(400, `events[${i}].unit_count must be a positive integer`);
        }
        if (typeof e.occurred_at !== 'string' || isNaN(Date.parse(e.occurred_at))) {
          throw new AppError(400, `events[${i}].occurred_at must be a valid ISO 8601 timestamp`);
        }
        if (e.idempotency_key !== undefined && typeof e.idempotency_key !== 'string') {
          throw new AppError(400, `events[${i}].idempotency_key must be a string`);
        }
      }

      // ── Process events sequentially ─────────────────────────────────────────
      const results = [];
      let accepted = 0;
      let duplicates = 0;

      for (const e of events) {
        const result = await recordUsageEvent(tenantId, productId, {
          event_type: e.event_type as string,
          unit_count: e.unit_count as number,
          occurred_at: e.occurred_at as string,
          idempotency_key: e.idempotency_key as string | undefined,
        });

        results.push(result);
        if (result.duplicate) {
          duplicates++;
        } else {
          accepted++;
        }
      }

      return reply.status(200).send({
        processed: events.length,
        accepted,
        duplicates,
        results,
      });
    },
  );
};

export default fp(usageRoutes, { name: 'usage-routes' });
