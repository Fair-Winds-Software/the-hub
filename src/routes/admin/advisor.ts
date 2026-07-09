// Authorized by HUB-1142 — POST /api/v1/admin/advisor/:productId/:tenantId/run; sync + async modes
// Authorized by HUB-1143 — GET /api/v1/admin/advisor/:productId/:tenantId/latest; Redis 60s cache; stale flag
// Authorized by HUB-1144 — POST /api/v1/admin/advisor/recommendations/:id/outcome; outcome write; cache invalidation
// Authorized by HUB-1148 — billing-summary, audit-note, recommendation history endpoints
// Authorized by HUB-1149 — enhanced portfolio/summary + CSV export endpoint
// Authorized by HUB-1699 (E-BE-1 S22) — GET /api/v1/admin/advisor/recommendations
//   (portfolio-wide flat list with productId + outcome filters); VALID_OUTCOME_TYPES expanded
//   to 6 values (won/lost/no_action added per advisor_outcome_type enum expansion in
//   migration 055). product_admin scoping mirrors HUB-1697 (handler-level products.tenant_id
//   ownership check after operatorRbacHook tenant match).
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import logger from '../../lib/logger.js';
import { getPool } from '../../db/pool.js';
import {
  runAdvisor,
  getLatestRecommendation,
  recordOutcome,
  getPortfolioSummary,
  getBillingSummary,
  addAuditNote,
  getRecommendationHistory,
  listRecommendations,
  type OutcomeType,
} from '../../services/planAdvisorService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_OUTCOME_TYPES = new Set<OutcomeType>([
  'applied',
  'dismissed',
  'auto_detected',
  'won',
  'lost',
  'no_action',
]);

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

const adminAdvisorRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Portfolio summary — must be before :productId/:tenantId to avoid route conflict ──

  fastify.get('/api/v1/admin/advisor/portfolio/summary', async (_request, reply) => {
    const summary = await getPortfolioSummary();
    return reply.send(summary);
  });

  // ── List recommendations (HUB-1699 E-BE-1 S22) ────────────────────────────────
  //
  // GET /api/v1/admin/advisor/recommendations
  //   ?productId=<uuid>        (optional for super_admin; REQUIRED for product_admin)
  //   &outcome=<v-or-csv>      (optional; allowlist enum values)
  //   &limit=<int>             (default 50, capped at 200)
  //   &offset=<int>            (default 0)
  //
  // RBAC: super_admin unrestricted; product_admin must specify productId AND the product
  // must belong to their tenant (handler-level check; mirrors HUB-1697 audit-log pattern).
  // operatorRbacHook already enforced tenant_id query param matches claim.tenant_id.
  fastify.get('/api/v1/admin/advisor/recommendations', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const op = (request as { operatorUser?: { role: string; tenant_id: string | null } })
      .operatorUser;

    const productId = q.productId;
    if (productId !== undefined) assertUUID(productId, 'productId');

    if (op?.role === 'product_admin') {
      if (!productId) {
        throw new AppError(
          400,
          'PRODUCT_ID_REQUIRED: product_admin must specify productId',
        );
      }
      const ownerRes = await getPool().query<{ id: string }>(
        `SELECT id FROM products WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [productId, op.tenant_id],
      );
      if (ownerRes.rows.length === 0) {
        throw new AppError(
          403,
          'FORBIDDEN: product_admin does not have access to this product',
        );
      }
    }

    let outcomes: OutcomeType[] | undefined;
    if (q.outcome !== undefined) {
      const parts = q.outcome.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      for (const v of parts) {
        if (!VALID_OUTCOME_TYPES.has(v as OutcomeType)) {
          throw new AppError(
            400,
            `INVALID_OUTCOME: outcome must be one of ${[...VALID_OUTCOME_TYPES].join(', ')}`,
          );
        }
      }
      outcomes = parts as OutcomeType[];
    }

    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 200);
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);

    const result = await listRecommendations({ productId, outcomes, limit, offset });
    return reply.status(200).send(result);
  });

  // ── Portfolio summary CSV export (HUB-1149) ───────────────────────────────────

  fastify.get('/api/v1/admin/advisor/portfolio/summary/export', async (_request, reply) => {
    const summary = await getPortfolioSummary();

    const header = 'product_id,tenant_id,tenant_name,recommendation_type,confidence,suggested_plan_id,week_start,status\n';
    // HUB-1771 Phase 4: `escape` used to type-narrow to `string | null | undefined`,
    // but summary rows contain Date/number columns from pg (e.g., week_start). Coerce
    // to string first so `.replace` doesn't throw "v.replace is not a function".
    const csvRows = summary.rows.map((r) => {
      const escape = (v: unknown): string => {
        if (v == null) return '';
        const s = typeof v === 'string' ? v : String(v);
        return `"${s.replace(/"/g, '""')}"`;
      };
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
