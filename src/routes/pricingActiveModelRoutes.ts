// Authorized by HUB-692 — GET /api/v1/pricing/models/:productId/active; service auth; Redis cache EX 5; rate limit per clientId
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';
import { getRedisClient } from '../redis/client.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rate limit: per-clientId window/max configurable via env (same pattern as usageRoutes)
const PRICING_RL_MAX = parseInt(process.env.PRICING_RATE_LIMIT_MAX ?? '500', 10);
const PRICING_RL_WINDOW_MS = parseInt(process.env.PRICING_RATE_LIMIT_WINDOW_MS ?? '60000', 10);

function toTierMinMax(tiers: Array<{ tier_order: number; up_to_units: number | null; unit_price_cents: number }>) {
  const sorted = [...tiers].sort((a, b) => a.tier_order - b.tier_order);
  let prevMax = 0;
  return sorted.map((t) => {
    const tier_min_units = prevMax;
    const tier_max_units = t.up_to_units;
    prevMax = t.up_to_units != null ? t.up_to_units + 1 : prevMax;
    return {
      tier_order: t.tier_order,
      tier_min_units,
      tier_max_units,
      unit_price_cents: t.unit_price_cents,
    };
  });
}

const pricingActiveModelRoutes: FastifyPluginAsync = async (fastify) => {
  const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
  const DUMMY_HASH = await bcrypt.hash('__hub_pricing_dummy__', BCRYPT_ROUNDS);

  fastify.get(
    '/api/v1/pricing/models/:productId/active',
    async (request, reply) => {
      // ── Service auth ────────────────────────────────────────────────────────
      const clientId = request.headers['x-client-id'];
      const clientSecret = request.headers['x-client-secret'];

      if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
        throw new AppError(401, 'Missing x-client-id or x-client-secret headers');
      }

      const { rows: authRows } = await getPool().query<{
        client_secret_hash: string;
      }>(
        `SELECT pr.client_secret_hash
           FROM product_registrations pr
          WHERE pr.client_id = $1`,
        [clientId],
      );

      const authRow = authRows[0];
      const valid = await bcrypt.compare(clientSecret, authRow?.client_secret_hash ?? DUMMY_HASH);
      if (!authRow || !valid) {
        throw new AppError(401, 'Invalid credentials');
      }

      // ── Validate productId ──────────────────────────────────────────────────
      const { productId } = request.params as { productId: string };
      if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');

      // ── Rate limiting ───────────────────────────────────────────────────────
      try {
        const redis = getRedisClient();
        const rlKey = `hub:ratelimit:pricing:${clientId}`;
        const count = await redis.incr(rlKey);
        if (count === 1) {
          await redis.pexpire(rlKey, PRICING_RL_WINDOW_MS);
        }
        if (count > PRICING_RL_MAX) {
          const ttlMs = await redis.pttl(rlKey);
          const retryAfter = Math.ceil(Math.max(ttlMs, 0) / 1000);
          reply.header('Retry-After', String(retryAfter));
          throw new AppError(429, 'Pricing rate limit exceeded');
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.warn({ err, clientId }, 'Redis rate-limit check failed — failing open');
      }

      // ── Cache-aside: Redis GET ──────────────────────────────────────────────
      const cacheKey = `hub:settings:pricing:${productId}`;
      try {
        const redis = getRedisClient();
        const cached = await redis.get(cacheKey);
        if (cached) {
          return reply.status(200).send(JSON.parse(cached));
        }
      } catch (err) {
        logger.warn({ err, productId }, 'Redis GET failed for pricing cache — falling back to DB');
      }

      // ── DB fallback ─────────────────────────────────────────────────────────
      const pool = getPool();
      const { rows: modelRows } = await pool.query<{
        id: string;
        product_id: string;
        model_type: string;
        config: Record<string, unknown>;
        active: boolean;
        created_at: Date;
      }>(
        `SELECT id, product_id, model_type, config, active, created_at
           FROM pricing_models
          WHERE product_id = $1 AND active = true
          LIMIT 1`,
        [productId],
      );

      if (modelRows.length === 0) throw new AppError(404, 'No active pricing model for product');

      const model = modelRows[0]!;

      const { rows: tierRows } = await pool.query<{
        tier_order: number;
        up_to_units: number | null;
        unit_price_cents: number;
      }>(
        `SELECT tier_order, up_to_units, unit_price_cents
           FROM price_tiers
          WHERE model_id = $1
          ORDER BY tier_order ASC`,
        [model.id],
      );

      const isTiered = model.model_type === 'tiered';
      const unit_price_cents = isTiered
        ? null
        : (model.config.unit_price_cents as number | undefined)
          ?? (model.config.seat_price_cents as number | undefined)
          ?? (model.config.price_cents as number | undefined)
          ?? null;

      const responseBody = {
        id: model.id,
        product_id: model.product_id,
        model_type: model.model_type,
        unit_price_cents,
        ...(isTiered && tierRows.length > 0 ? { tiers: toTierMinMax(tierRows) } : {}),
        is_active: model.active,
        created_at: model.created_at.toISOString(),
      };

      // ── Populate cache EX 5 ─────────────────────────────────────────────────
      try {
        const redis = getRedisClient();
        await redis.set(cacheKey, JSON.stringify(responseBody), 'EX', 5);
      } catch (err) {
        logger.warn({ err, productId }, 'Redis SET failed for pricing cache — DB response still returned');
      }

      return reply.status(200).send(responseBody);
    },
  );
};

export default fp(pricingActiveModelRoutes, { name: 'pricing-active-model-routes' });
