// Authorized by HUB-112 — Operator auth plugin; slot 5 in app.ts plugin chain
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

declare module 'fastify' {
  interface FastifyRequest {
    operator_id?: string;
    operator_role?: string;
  }
  interface FastifyInstance {
    authenticateOperator: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface OperatorJwtPayload {
  operator_id: string;
  role: string;
  iat: number;
  exp: number;
}

// requireRole returns a preHandler that gates a route to operators with the specified role.
// Usage: { preHandler: [fastify.authenticateOperator, requireRole('admin')] }
export function requireRole(role: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (request.operator_role !== role) {
      throw new AppError(403, 'Forbidden');
    }
  };
}

const operatorAuthPlugin: FastifyPluginAsync = async (fastify) => {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

  // Pre-computed once at startup for timing-safe rejection when username not found
  const DUMMY_HASH = await bcrypt.hash('__hub_operator_dummy__', rounds);

  // ── POST /api/v1/operator/auth/token ───────────────────────────────────────
  fastify.post<{ Body: { username: string; password: string } }>(
    '/api/v1/operator/auth/token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body;

      const { rows } = await getPool().query<{
        operator_id: string;
        password_hash: string;
        role: string;
      }>(
        `SELECT operator_id, password_hash, role FROM operators WHERE username = $1`,
        [username],
      );

      const row = rows[0];

      // Always bcrypt.compare — even against dummy hash — to prevent timing oracle
      const valid = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);

      if (!row || !valid) {
        throw new AppError(401, 'Invalid credentials');
      }

      const secret = process.env.OPERATOR_JWT_SECRET!;
      const expiresIn = parseInt(process.env.OPERATOR_JWT_EXPIRES_IN ?? '3600', 10);

      const token = jwt.sign(
        { operator_id: row.operator_id, role: row.role },
        secret,
        { expiresIn },
      );

      return reply.send({ access_token: token, expires_in: expiresIn });
    },
  );

  // ── Operator JWT preHandler decorator ──────────────────────────────────────
  fastify.decorate(
    'authenticateOperator',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw new AppError(401, 'Invalid or expired token');
      }

      const token = authHeader.slice(7);
      const secret = process.env.OPERATOR_JWT_SECRET!;

      try {
        const payload = jwt.verify(token, secret) as OperatorJwtPayload;
        request.operator_id = payload.operator_id;
        request.operator_role = payload.role;
      } catch {
        throw new AppError(401, 'Invalid or expired token');
      }
    },
  );
};

// fp() escapes plugin scope so authenticateOperator decorator and request augmentation
// are available to all downstream route plugins.
export default fp(operatorAuthPlugin);
