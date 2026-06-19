// Authorized by HUB-1521 — GET /api/v1/analytics/usage, /billing, /health; operator JWT; tenant scoping

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { getUsageAnalytics, getBillingAnalytics } from '../services/analyticsService.js';
import { AppError } from '../errors/AppError.js';

interface OperatorClaims {
  operator_id: string;
  role: 'super_admin' | 'tenant_admin';
  tenant_id: string | null;
}

async function requireOperatorJwt(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) throw new AppError(401, 'Unauthorized');
  const token = authHeader.slice(7);
  try {
    const claims = jwt.verify(
      token,
      process.env.OPERATOR_JWT_SECRET!,
    ) as OperatorClaims;
    request.operatorUser = {
      operator_id: claims.operator_id,
      role: claims.role,
      tenant_id: claims.tenant_id ?? null,
    };
  } catch {
    throw new AppError(401, 'Unauthorized');
  }
}

function parseDateParams(q: Record<string, string | undefined>): { from: Date; to: Date } {
  const from_str = q['from'];
  const to_str = q['to'];
  if (!from_str || !to_str) throw new AppError(400, 'from and to are required');
  const from = new Date(from_str);
  const to = new Date(to_str);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new AppError(400, 'from and to must be valid ISO8601 dates');
  }
  return { from, to };
}

const analyticsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/api/v1/analytics/usage',
    { preHandler: [requireOperatorJwt] },
    async (request, reply) => {
      const op = request.operatorUser!;
      const q = request.query as Record<string, string | undefined>;
      const { from, to } = parseDateParams(q);

      let tenantId: string | undefined;
      if (op.role === 'tenant_admin') {
        // tenant_admin may only query their own tenant
        const requested = q['tenant_id'];
        if (requested && requested !== op.tenant_id) throw new AppError(403, 'Forbidden');
        if (!op.tenant_id) throw new AppError(403, 'Forbidden');
        tenantId = op.tenant_id;
      } else {
        tenantId = q['tenant_id'];
      }

      const rawLimit = parseInt(q['limit'] ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit;

      const result = await getUsageAnalytics({
        tenantId,
        productId: q['product_id'],
        from,
        to,
        limit,
        cursor: q['cursor'],
      });

      return reply.status(200).send(result);
    },
  );

  fastify.get(
    '/api/v1/analytics/billing',
    { preHandler: [requireOperatorJwt] },
    async (request, reply) => {
      const op = request.operatorUser!;
      if (op.role !== 'super_admin') throw new AppError(403, 'Forbidden');

      const q = request.query as Record<string, string | undefined>;
      const { from, to } = parseDateParams(q);

      if (!q['product_id']) throw new AppError(400, 'product_id is required');

      const result = await getBillingAnalytics({
        productId: q['product_id'],
        from,
        to,
      });

      return reply.status(200).send(result);
    },
  );

  fastify.get('/api/v1/analytics/health', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      code: 'TODO-D-I9-003',
      message: 'Health analytics require a dedicated metrics store not yet deployed',
    });
  });
};

export default fp(analyticsRoutes, { name: 'analytics-routes' });
