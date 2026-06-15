// Authorized by HUB-391 — POST /api/v1/leases/issue; SDK lease issuance
// Authorized by HUB-392 — POST /api/v1/leases/verify; SDK lease verification
// Authorized by HUB-393 — DELETE /api/v1/leases/:leaseId; operator lease revocation
// Authorized by HUB-552 — POST /api/v1/leases/issue and verify with service auth and rate limiting
// Authorized by HUB-553 — POST /api/v1/leases/:leaseId/extend with operator JWT auth
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';
import { getRedisClient } from '../redis/client.js';
import { AppError } from '../errors/AppError.js';
import { issueLease, verifyLease, revokeLease, extendLease } from '../services/leaseService.js';

// Resolves service auth from Authorization: Basic base64(client_id:client_secret).
// Returns { clientId, productId, rawClientSecret } on success.
// Throws AppError(401) on any auth failure.
async function resolveServiceAuth(
  request: FastifyRequest,
): Promise<{ clientId: string; productId: string; rawClientSecret: string }> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Basic ')) {
    throw new AppError(401, 'Service credentials required');
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx < 1) {
    throw new AppError(401, 'Invalid credentials format');
  }
  const clientId = decoded.slice(0, colonIdx);
  const rawClientSecret = decoded.slice(colonIdx + 1);

  const pool = getPool();
  const { rows } = await pool.query<{ product_id: string; client_secret_hash: string }>(
    `SELECT product_id, client_secret_hash
     FROM product_registrations
     WHERE client_id = $1`,
    [clientId],
  );

  const row = rows[0];
  // Always run bcrypt.compare — even on missing row — to prevent timing oracle
  const dummyHash = '$2a$10$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const valid = await bcrypt.compare(rawClientSecret, row?.client_secret_hash ?? dummyHash);

  if (!row || !valid) {
    throw new AppError(401, 'Invalid credentials');
  }

  return { clientId, productId: row.product_id, rawClientSecret };
}

// Redis-backed rate limiter per clientId for the lease issue endpoint.
// Throws AppError(429) with Retry-After header when limit exceeded.
async function checkLeaseRateLimit(clientId: string, reply: FastifyReply): Promise<void> {
  const redis = getRedisClient();
  const max = parseInt(process.env.LEASE_RATE_LIMIT_MAX ?? '60', 10);
  const windowMs = parseInt(process.env.LEASE_RATE_LIMIT_WINDOW_MS ?? '60000', 10);
  const key = `hub:ratelimit:leases:${clientId}`;

  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, windowMs);

  if (count > max) {
    const ttl = await redis.pttl(key);
    reply.header('Retry-After', String(Math.ceil(Math.max(ttl, 0) / 1000)));
    throw new AppError(429, 'Too many requests');
  }
}

const leasesRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/v1/leases/issue ───────────────────────────────────────────────
  fastify.post<{
    Body: { tenantId: string; productId: string; sdkVersion: string };
  }>(
    '/api/v1/leases/issue',
    {
      schema: {
        body: {
          type: 'object',
          required: ['tenantId', 'productId', 'sdkVersion'],
          properties: {
            tenantId: { type: 'string' },
            productId: { type: 'string' },
            sdkVersion: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { clientId, productId: resolvedProductId, rawClientSecret } = await resolveServiceAuth(request);
      await checkLeaseRateLimit(clientId, reply);

      const { tenantId, sdkVersion } = request.body;

      const { signedPayload, expiresAt, renewsAt } = await issueLease(
        tenantId,
        resolvedProductId,
        sdkVersion,
        rawClientSecret,
      );

      return reply.code(200).send({
        signedPayload,
        expiresAt: expiresAt.toISOString(),
        renewsAt: renewsAt.toISOString(),
      });
    },
  );

  // ── POST /api/v1/leases/verify ──────────────────────────────────────────────
  fastify.post<{
    Body: { signedPayload: string; clientSecret: string };
  }>(
    '/api/v1/leases/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['signedPayload', 'clientSecret'],
          properties: {
            signedPayload: { type: 'string' },
            clientSecret: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      // Service auth validates the caller identity; clientSecret in body is for HMAC verification
      await resolveServiceAuth(request);
      const { signedPayload, clientSecret } = request.body;
      const result = await verifyLease(signedPayload, clientSecret);
      return reply.code(200).send(result);
    },
  );

  // ── POST /api/v1/leases/:leaseId/extend ────────────────────────────────────
  fastify.post<{
    Params: { leaseId: string };
    Body: { daysToExtend: number };
  }>(
    '/api/v1/leases/:leaseId/extend',
    {
      schema: {
        params: {
          type: 'object',
          required: ['leaseId'],
          properties: { leaseId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['daysToExtend'],
          properties: { daysToExtend: { type: 'integer' } },
          additionalProperties: false,
        },
      },
      preHandler: [fastify.authenticateOperator],
    },
    async (request, reply) => {
      const { leaseId } = request.params;
      const { daysToExtend } = request.body;
      const operatorId = request.operator_id ?? 'unknown';

      if (!daysToExtend || daysToExtend <= 0) {
        throw new AppError(400, 'daysToExtend must be a positive integer');
      }

      const result = await extendLease(leaseId, daysToExtend, operatorId);
      return reply.code(200).send({
        leaseId: result.leaseId,
        expiresAt: result.expiresAt.toISOString(),
        renewsAt: result.renewsAt.toISOString(),
      });
    },
  );

  // ── DELETE /api/v1/leases/:leaseId ─────────────────────────────────────────
  fastify.delete<{
    Params: { leaseId: string };
    Body: { reason: string };
  }>(
    '/api/v1/leases/:leaseId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['leaseId'],
          properties: { leaseId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
      preHandler: [fastify.authenticateOperator],
    },
    async (request, reply) => {
      const { leaseId } = request.params;
      const { reason } = request.body;
      const row = await revokeLease(leaseId, reason);
      return reply.code(200).send({
        id: row.id,
        revoked_at: row.revoked_at,
        revoke_reason: row.revoke_reason,
      });
    },
  );
};

export default fp(leasesRoutes, { name: 'leases-routes' });
