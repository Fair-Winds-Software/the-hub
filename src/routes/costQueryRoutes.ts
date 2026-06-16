// Authorized by HUB-699 — POST /api/v1/pricing/calculate/:productId; GET /api/v1/costs/:tenantId; GET .../current; GET /api/v1/pricing/margin-summary/:tenantId; operator JWT
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import {
  calculateCost,
  getCurrentPeriodCost,
  getPeriodCostHistory,
  getMarginSummary,
} from '../services/costCalculationService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

const costQueryRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/v1/pricing/calculate/:productId ──────────────────────────────
  fastify.post(
    '/api/v1/pricing/calculate/:productId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { productId } = request.params as { productId: string };
      assertUUID(productId, 'productId');

      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body.unitCount !== 'number' || !Number.isInteger(body.unitCount)) {
        throw new AppError(400, 'unitCount must be an integer');
      }

      const result = await calculateCost(productId, body.unitCount as number);
      return reply.status(200).send(result);
    },
  );

  // ── GET /api/v1/costs/:tenantId — billing_period_costs history ─────────────
  fastify.get(
    '/api/v1/costs/:tenantId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      assertUUID(tenantId, 'tenantId');

      const query = request.query as Record<string, string | undefined>;
      const { productId, periodStart: periodStartStr, periodEnd: periodEndStr } = query;

      if (!productId) throw new AppError(400, 'productId is required');
      assertUUID(productId, 'productId');

      const periodStart = periodStartStr ? new Date(periodStartStr) : undefined;
      const periodEnd = periodEndStr ? new Date(periodEndStr) : undefined;

      const rows = await getPeriodCostHistory(tenantId, productId, periodStart, periodEnd);
      return reply.status(200).send(rows);
    },
  );

  // ── GET /api/v1/costs/:tenantId/current — live SUM from cost_ledger ────────
  fastify.get(
    '/api/v1/costs/:tenantId/current',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      assertUUID(tenantId, 'tenantId');

      const query = request.query as Record<string, string | undefined>;
      const { productId } = query;
      if (!productId) throw new AppError(400, 'productId is required');
      assertUUID(productId, 'productId');

      // Resolve current period boundary from stripe_subscriptions
      const { rows: subRows } = await getPool().query<{ current_period_start: Date }>(
        `SELECT current_period_start
           FROM stripe_subscriptions
          WHERE tenant_id  = $1
            AND product_id = $2
          ORDER BY current_period_start DESC
          LIMIT 1`,
        [tenantId, productId],
      );

      const periodStart = subRows[0]?.current_period_start ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const result = await getCurrentPeriodCost(tenantId, productId, periodStart);
      return reply.status(200).send(result);
    },
  );

  // ── GET /api/v1/pricing/margin-summary/:tenantId ───────────────────────────
  fastify.get(
    '/api/v1/pricing/margin-summary/:tenantId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      assertUUID(tenantId, 'tenantId');

      const query = request.query as Record<string, string | undefined>;
      const { productId } = query;
      if (!productId) throw new AppError(400, 'productId is required');
      assertUUID(productId, 'productId');

      const rows = await getMarginSummary(tenantId, productId);
      return reply.status(200).send(rows);
    },
  );
};

export default fp(costQueryRoutes, { name: 'cost-query-routes' });
