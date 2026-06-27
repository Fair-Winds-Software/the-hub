// Authorized by HUB-1521 — GET /api/v1/analytics/usage, /billing, /health; operator JWT; tenant scoping
// Authorized by HUB-1596 (E-BE-1 S13, CR-3) — GET /api/v1/analytics/portfolio-margin; both
//   super_admin + product_admin may read. Path matches the file's existing convention
//   (/api/v1/analytics/...) — the story spec said /api/v1/admin/analytics/... but the actual
//   file does not use /admin/ for analytics; matching siblings here. R1 cross-Epic contract
//   (200 + {available:false}) applied for upstream failures.

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { getUsageAnalytics, getBillingAnalytics, getPortfolioMargin } from '../services/analyticsService.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

interface OperatorClaims {
  operator_id: string;
  role: 'super_admin' | 'product_admin';
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

function parseIsoDate(raw: string, label: string): Date {
  const d = new Date(raw);
  if (isNaN(d.getTime())) throw new AppError(400, `${label} is not a valid ISO8601 date`);
  return d;
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
      if (op.role === 'product_admin') {
        // product_admin may only query their own tenant
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

  // HUB-1596 (E-BE-1 S13, CR-3): portfolio margin endpoint over HUB-1595's aggregator.
  //
  // Query params:
  //   from, to — optional ISO8601 dates. Default: last 30 days.
  //   Range MUST be ≤ 90 days (R1 FIX; getPortfolioMargin enforces via validateRange).
  //
  // RBAC: super_admin + product_admin both allowed (read-only signal, no PII).
  //
  // Degraded contract (R1, mirrors HUB-1594): genuine validation errors → 400 with code;
  // upstream errors (DB unreachable, query timeout) → 200 with {available:false, reason}
  // so the dashboard tile renders "—" without an error state.
  fastify.get(
    '/api/v1/analytics/portfolio-margin',
    { preHandler: [requireOperatorJwt] },
    async (request, reply) => {
      const q = request.query as Record<string, string | undefined>;
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      let from: Date;
      let to: Date;
      try {
        from = q['from'] ? parseIsoDate(q['from'], 'from') : defaultFrom;
        to = q['to'] ? parseIsoDate(q['to'], 'to') : now;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(400, 'INVALID_DATE');
      }
      if (from > to) {
        throw new AppError(400, 'RANGE_INVERTED');
      }

      try {
        const result = await getPortfolioMargin({ from, to });
        return reply.status(200).send({ available: true, ...result });
      } catch (err) {
        // 400-class errors from validateRange (range > 90 days) bubble up as actual 400s.
        if (err instanceof AppError) throw err;
        logger.warn({ err }, 'portfolio-margin: upstream error — degrading');
        return reply.status(200).send({ available: false, reason: 'upstream_unavailable' });
      }
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
