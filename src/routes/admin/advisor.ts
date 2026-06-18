// Authorized by HUB-1142 — POST /api/v1/admin/advisor/:productId/:tenantId/run; sync + async modes
// Authorized by HUB-1143 — GET /api/v1/admin/advisor/:productId/:tenantId/latest; Redis 60s cache; stale flag
// Authorized by HUB-1144 — POST /api/v1/admin/advisor/recommendations/:id/outcome; outcome write; cache invalidation
// Authorized by HUB-1148 — billing-summary, audit-note, recommendation history endpoints
// Authorized by HUB-1149 — enhanced portfolio/summary + CSV export endpoint
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import logger from '../../lib/logger.js';
import {
  runAdvisor,
  getLatestRecommendation,
  recordOutcome,
  getPortfolioSummary,
  getBillingSummary,
  addAuditNote,
  getRecommendationHistory,
  type OutcomeType,
} from '../../services/planAdvisorService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_OUTCOME_TYPES = new Set<OutcomeType>(['applied', 'dismissed', 'auto_detected']);

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

const adminAdvisorRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Portfolio summary — must be before :productId/:tenantId to avoid route conflict ──

  fastify.get('/api/v1/admin/advisor/portfolio/summary', async (_request, reply) => {
    const summary = await getPortfolioSummary();
    return reply.send(summary);
  });

  // ── Portfolio summary CSV export (HUB-1149) ───────────────────────────────────

  fastify.get('/api/v1/admin/advisor/portfolio/summary/export', async (_request, reply) => {
    const summary = await getPortfolioSummary();

    const header = 'product_id,tenant_id,tenant_name,recommendation_type,confidence,suggested_plan_id,week_start,status\n';
    const csvRows = summary.rows.map((r) => {
      const escape = (v: string | null | undefined): string =>
        v == null ? '' : `"${v.replace(/"/g, '""')}"`;
      return [
        escape(r.product_id),
        escape(r.tenant_id),
        escape(r.tenant_name),
        escape(r.recommendation_type),
        escape(r.confidence),
        '',
        escape(r.week_start),
        escape(r.status),
      ].join(',');
    });

    const csv = header + csvRows.join('\n');

    return reply
      .header('Content-Type', 'text/csv')
      .header('Content-Disposition', 'attachment; filename="portfolio-summary.csv"')
      .send(csv);
  });

  // ── Run advisor ───────────────────────────────────────────────────────────────

  fastify.post(
    '/api/v1/admin/advisor/:productId/:tenantId/run',
    async (request, reply) => {
      const { productId, tenantId } = request.params as { productId: string; tenantId: string };
      assertUUID(productId, 'productId');
      assertUUID(tenantId, 'tenantId');

      const q = request.query as Record<string, string | undefined>;
      const isAsync = q.async === 'true';

      if (isAsync) {
        // Non-blocking fire: 202 immediately
        runAdvisor(productId, tenantId).catch((err: unknown) => {
          logger.error({ err, productId, tenantId }, 'Async advisor run failed');
        });
        return reply.status(202).send({ status: 'queued', productId, tenantId });
      }

      const result = await runAdvisor(productId, tenantId);
      return reply.send(result);
    },
  );

  // ── Latest recommendation ─────────────────────────────────────────────────────

  fastify.get(
    '/api/v1/admin/advisor/:productId/:tenantId/latest',
    async (request, reply) => {
      const { productId, tenantId } = request.params as { productId: string; tenantId: string };
      assertUUID(productId, 'productId');
      assertUUID(tenantId, 'tenantId');

      const result = await getLatestRecommendation(productId, tenantId);
      if (!result) throw new AppError(404, 'No recommendation found for this product/tenant pair');

      return reply.send(result);
    },
  );

  // ── Billing summary (HUB-1148) ───────────────────────────────────────────────

  fastify.get(
    '/api/v1/admin/advisor/:productId/:tenantId/billing-summary',
    async (request, reply) => {
      const { productId, tenantId } = request.params as { productId: string; tenantId: string };
      assertUUID(productId, 'productId');
      assertUUID(tenantId, 'tenantId');

      const periods = await getBillingSummary(productId, tenantId);
      return reply.send({ periods });
    },
  );

  // ── Recommendation history — last N weeks (HUB-1148) ─────────────────────────

  fastify.get(
    '/api/v1/admin/advisor/:productId/:tenantId/history',
    async (request, reply) => {
      const { productId, tenantId } = request.params as { productId: string; tenantId: string };
      assertUUID(productId, 'productId');
      assertUUID(tenantId, 'tenantId');

      const q = request.query as Record<string, string | undefined>;
      const weeks = Math.min(parseInt(q.weeks ?? '4', 10), 12);

      const history = await getRecommendationHistory(productId, tenantId, weeks);
      return reply.send({ recommendations: history });
    },
  );

  // ── Audit note on a recommendation (HUB-1148) ────────────────────────────────

  fastify.post(
    '/api/v1/admin/advisor/recommendations/:id/audit-note',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      assertUUID(id, 'id');

      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body.note !== 'string' || !body.note.trim()) {
        throw new AppError(400, 'note is required and must be a non-empty string');
      }

      const operatorUser = (request as { operatorUser?: { operator_id?: string } }).operatorUser;

      try {
        const result = await addAuditNote(id, body.note, operatorUser?.operator_id);
        return reply.status(201).send(result);
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404) {
          throw new AppError(404, 'Recommendation not found');
        }
        throw err;
      }
    },
  );

  // ── Record outcome ────────────────────────────────────────────────────────────

  fastify.post(
    '/api/v1/admin/advisor/recommendations/:id/outcome',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      assertUUID(id, 'id');

      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body.outcome_type !== 'string') {
        throw new AppError(400, 'outcome_type is required');
      }
      if (!VALID_OUTCOME_TYPES.has(body.outcome_type as OutcomeType)) {
        throw new AppError(400, `outcome_type must be one of: ${[...VALID_OUTCOME_TYPES].join(', ')}`);
      }

      try {
        const outcome = await recordOutcome(id, {
          outcomeType: body.outcome_type as OutcomeType,
          outcomeValue: body.outcome_value,
          notes: typeof body.notes === 'string' ? body.notes : undefined,
        });
        return reply.status(201).send(outcome);
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404) {
          throw new AppError(404, 'Recommendation not found');
        }
        throw err;
      }
    },
  );
};

export default adminAdvisorRoutes;
