// Authorized by HUB-1521 — GET /api/v1/analytics/usage, /billing, /health; operator JWT; tenant scoping
// Authorized by HUB-1596 (E-BE-1 S13, CR-3) — GET /api/v1/analytics/portfolio-margin; both
//   super_admin + product_admin may read. Path matches the file's existing convention
//   (/api/v1/analytics/...) — the story spec said /api/v1/admin/analytics/... but the actual
//   file does not use /admin/ for analytics; matching siblings here. R1 cross-Epic contract
//   (200 + {available:false}) applied for upstream failures.
// Authorized by HUB-1598 (E-BE-1 S15, CR-5 chain final) — POST /api/v1/analytics/pricing-scenario.
//   Same path convention deviation as HUB-1596 (no /admin/). Wraps HUB-1597's compute split:
//   fetchScenarioBaseline (impure) + computeScenario (pure). R1 contract: snake_case body fields
//   (D-HUB-SCOPE-039) + camelCase response (R2 Amendment 4 deferral). Audit writes ONE row per
//   successful request unconditionally (FIX#1 per-request SOC 2 trail). 404 PRICING-001 when the
//   product has no active pricing model (R2 Amendment 2 / D-HUB-SCOPE-040). Audit schema mapping
//   per HUB-1586: operation='INSERT' + event_type='analytics.pricing_scenario_compute' +
//   table_name='products' + record_id=productId.

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import {
  getUsageAnalytics,
  getBillingAnalytics,
  getPortfolioMargin,
  fetchScenarioBaseline,
  computeScenario,
} from '../services/analyticsService.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getPool } from '../db/pool.js';
import { writeAuditEntry } from '../services/auditLogService.js';

const HUB_INTERNAL_TENANT_ID = '00000000-0000-0000-0000-0000000000a1';

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

  // HUB-1598 (E-BE-1 S15, CR-5 chain final): POST /api/v1/analytics/pricing-scenario.
  //
  // Body (snake_case per D-HUB-SCOPE-039):
  //   product_id (required, uuid string)
  //   baseline_model_id (optional, uuid string)
  //   price_change_percent (required, > -100 and ≤ 1000)
  //   churn_assumption_percent (required, 0..100)
  //
  // Response (camelCase per R2 Amendment 4 deferral):
  //   { baseline, scenario, delta, modelType, disclaimer, baselineSnapshotAt, generatedAt }
  //
  // RBAC: super_admin + product_admin (compute is read-only; no tenant scoping — HUB-internal).
  //
  // Audit (R1 FIX#1 — one row per request, unconditional on 200; R1 FIX#2 — full detail):
  //   operation='INSERT', event_type='analytics.pricing_scenario_compute',
  //   table_name='products', record_id=productId,
  //   new_values={ productId, baselineModelId, scenarioInput, baselineSnapshotAt, deltaSummary }
  //   (deltaSummary keeps revenueCents — service contract is cents, not dollars; documented.)
  //
  // 404 PRICING-001 (R2 Amendment 2 / D-HUB-SCOPE-040): if product has no active pricing_models
  //   row, respond {error:'no_pricing_model', code:'PRICING-001'} and write NO audit row.
  fastify.post(
    '/api/v1/analytics/pricing-scenario',
    { preHandler: [requireOperatorJwt] },
    async (request, reply) => {
      const op = request.operatorUser!;
      const body = (request.body ?? {}) as Record<string, unknown>;

      const productId = body['product_id'];
      const baselineModelId = body['baseline_model_id'] ?? null;
      const priceChangePercent = body['price_change_percent'];
      const churnAssumptionPercent = body['churn_assumption_percent'];

      if (typeof productId !== 'string' || productId.length === 0) {
        throw new AppError(400, 'product_id is required');
      }
      if (baselineModelId !== null && typeof baselineModelId !== 'string') {
        throw new AppError(400, 'baseline_model_id must be a string');
      }
      if (typeof priceChangePercent !== 'number' || !Number.isFinite(priceChangePercent)) {
        throw new AppError(400, 'price_change_percent must be a finite number');
      }
      if (priceChangePercent <= -100 || priceChangePercent > 1000) {
        throw new AppError(400, 'price_change_percent must be > -100 and ≤ 1000');
      }
      if (
        typeof churnAssumptionPercent !== 'number' ||
        !Number.isFinite(churnAssumptionPercent)
      ) {
        throw new AppError(400, 'churn_assumption_percent must be a finite number');
      }
      if (churnAssumptionPercent < 0 || churnAssumptionPercent > 100) {
        throw new AppError(400, 'churn_assumption_percent must be between 0 and 100');
      }

      // R2 Amendment 2: no active pricing model → 404 PRICING-001, no audit row.
      const pool = getPool();
      const modelRes = await pool.query<{ id: string }>(
        `SELECT id FROM pricing_models WHERE product_id = $1 AND active = true LIMIT 1`,
        [productId],
      );
      if (modelRes.rows.length === 0) {
        return reply
          .status(404)
          .send({ error: 'no_pricing_model', code: 'PRICING-001' });
      }

      const baseline = await fetchScenarioBaseline(productId);
      const result = computeScenario(baseline, {
        priceChangePercent,
        churnAssumptionPercent,
      });

      const generatedAt = new Date().toISOString();
      const response = {
        baseline: result.baseline,
        scenario: result.scenario,
        delta: result.delta,
        modelType: result.modelType,
        disclaimer: result.disclaimer,
        baselineSnapshotAt: result.baseline.snapshotAt,
        generatedAt,
      };

      await writeAuditEntry({
        tenant_id: HUB_INTERNAL_TENANT_ID,
        product_id: productId,
        actor_id: op.operator_id,
        actor_type: 'operator',
        operation: 'INSERT',
        table_name: 'products',
        record_id: productId,
        event_type: 'analytics.pricing_scenario_compute',
        new_values: {
          productId,
          baselineModelId,
          scenarioInput: { priceChangePercent, churnAssumptionPercent },
          baselineSnapshotAt: result.baseline.snapshotAt,
          deltaSummary: {
            deltaRevenueCents: result.delta.revenueCents,
            deltaMarginPctPoints: result.delta.marginPctPoints,
          },
        },
      });

      return reply.status(200).send(response);
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
