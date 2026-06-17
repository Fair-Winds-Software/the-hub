// Authorized by HUB-98 — Service auth plugin; slot 4 in app.ts plugin chain
// Authorized by HUB-1127 — auth/token validates product.active AND tenant.active; inactive → 401
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

// Augment Fastify types with auth context and authenticate decorator
declare module 'fastify' {
  interface FastifyRequest {
    tenant_id: string;
    product_id: string;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface JwtPayload {
  tenant_id: string;
  product_id: string;
  iat: number;
  exp: number;
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

  // Pre-computed once at startup: ensures timing-safe rejection when client_id not found
  // without adding per-request overhead for the not-found path.
  const DUMMY_HASH = await bcrypt.hash('__hub_dummy__', rounds);

  // ── POST /api/v1/auth/token ─────────────────────────────────────────────────
  fastify.post<{ Body: { client_id: string; client_secret: string } }>(
    '/api/v1/auth/token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['client_id', 'client_secret'],
          properties: {
            client_id: { type: 'string' },
            client_secret: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { client_id, client_secret } = request.body;

      const { rows } = await getPool().query<{
        product_id: string;
        tenant_id: string;
        client_secret_hash: string;
      }>(
        `SELECT pr.product_id, p.tenant_id, pr.client_secret_hash
           FROM product_registrations pr
           JOIN products p ON p.id = pr.product_id
           JOIN tenants t ON t.id = p.tenant_id
          WHERE pr.client_id = $1
            AND p.active = true
            AND t.active = true`,
        [client_id],
      );

      const row = rows[0];

      // Always bcrypt.compare — even against dummy hash — to prevent timing oracle
      const valid = await bcrypt.compare(client_secret, row?.client_secret_hash ?? DUMMY_HASH);

      if (!row || !valid) {
        throw new AppError(401, 'Invalid credentials');
      }

      const secret = process.env.JWT_SECRET!;
      const expiresIn = parseInt(process.env.JWT_EXPIRES_IN ?? '900', 10);

      const token = jwt.sign(
        { tenant_id: row.tenant_id, product_id: row.product_id },
        secret,
        { expiresIn },
      );

      return reply.send({ access_token: token, expires_in: expiresIn });
    },
  );

  // ── JWT preHandler decorator ────────────────────────────────────────────────
  // Business route plugins register routes with { preHandler: [fastify.authenticate] }.
  // fp() ensures this decorator is visible across all plugin scopes.
  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw new AppError(401, 'Invalid or expired token');
      }

      const token = authHeader.slice(7);
      const secret = process.env.JWT_SECRET!;

      try {
        const payload = jwt.verify(token, secret) as JwtPayload;
        request.tenant_id = payload.tenant_id;
        request.product_id = payload.product_id;
      } catch {
        throw new AppError(401, 'Invalid or expired token');
      }
    },
  );
};

// fp() escapes plugin scope so authenticate decorator and request augmentation
// are available to all downstream business route plugins.
export default fp(authPlugin);
