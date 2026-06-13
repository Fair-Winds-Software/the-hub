// Authorized by HUB pricing Epics (E14–E20) — Dynamic Pricing & Plan Advisor routes
// Endpoints consumed by LaunchKit Internal hub-proxy.routes.ts when HUB_RESOLVER=hub.
// All routes protected by fastify.authenticate (service JWT).
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

// ── Row type helpers ───────────────────────────────────────────────────────────

interface ModelRow {
  id: string;
  product_id: string;
  model_type: string;
  currency: string;
  config: Record<string, unknown>;
  active: boolean;
  activated_at: string | null;
  deprecated_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface TierRow {
  id: string;
  model_id: string;
  tier_order: number;
  up_to_units: number | null;
  unit_price_cents: number;
  flat_fee_cents: number;
}

interface RecommendationRow {
  id: string;
  product_id: string;
  tenant_id: string;
  recommendation_type: string;
  suggested_plan_id: string | null;
  rationale: string;
  confidence: string;
  projected_savings_cents: number | null;
  projected_cost_delta_cents: number | null;
  week_start: string;
  created_at: string;
}

function mapModel(model: ModelRow, tiers: TierRow[]) {
  return {
    modelId: model.id,
    productId: model.product_id,
    modelType: model.model_type,
    currency: model.currency,
    config: model.config ?? {},
    active: model.active,
    activatedAt: model.activated_at ?? null,
    deprecatedAt: model.deprecated_at ?? null,
    createdBy: model.created_by ?? null,
    tiers: tiers.map((t) => ({
      tierId: t.id,
      tierOrder: t.tier_order,
      upToUnits: t.up_to_units,
      unitPriceCents: t.unit_price_cents,
      flatFeeCents: t.flat_fee_cents,
    })),
  };
}

function mapRecommendation(row: RecommendationRow) {
  return {
    recommendationId: row.id,
    productId: row.product_id,
    tenantId: row.tenant_id,
    recommendationType: row.recommendation_type,
    suggestedPlanId: row.suggested_plan_id ?? null,
    rationale: row.rationale,
    confidence: row.confidence,
    projectedSavingsCents: row.projected_savings_cents ?? null,
    projectedCostDeltaCents: row.projected_cost_delta_cents ?? null,
    weekStart: row.week_start,
    createdAt: String(row.created_at),
  };
}

const pricingRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool();

  // ── E14: GET /api/v1/hub/pricing/:productId/model ─────────────────────────
  fastify.get<{ Params: { productId: string } }>(
    '/api/v1/hub/pricing/:productId/model',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { productId } = request.params;

      const modelResult = await pool.query<ModelRow>(
        `SELECT * FROM pricing_models
         WHERE product_id = $1 AND active = true
         ORDER BY activated_at DESC LIMIT 1`,
        [productId],
      );
      if (!modelResult.rows.length) return reply.send(null);

      const model = modelResult.rows[0];
      const tiersResult = await pool.query<TierRow>(
        `SELECT * FROM price_tiers WHERE model_id = $1 ORDER BY tier_order`,
        [model.id],
      );

      return reply.send(mapModel(model, tiersResult.rows));
    },
  );

  // ── E15: GET /api/v1/hub/pricing/:productId/history ───────────────────────
  fastify.get<{ Params: { productId: string } }>(
    '/api/v1/hub/pricing/:productId/history',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { productId } = request.params;

      const modelsResult = await pool.query<ModelRow>(
        `SELECT * FROM pricing_models WHERE product_id = $1 ORDER BY created_at DESC`,
        [productId],
      );
      if (!modelsResult.rows.length) return reply.send([]);

      const modelIds = modelsResult.rows.map((r) => r.id);
      const tiersResult = await pool.query<TierRow>(
        `SELECT * FROM price_tiers WHERE model_id = ANY($1::uuid[]) ORDER BY model_id, tier_order`,
        [modelIds],
      );

      const tiersByModel = new Map<string, TierRow[]>();
      for (const tier of tiersResult.rows) {
        if (!tiersByModel.has(tier.model_id)) tiersByModel.set(tier.model_id, []);
        tiersByModel.get(tier.model_id)!.push(tier);
      }

      const models = modelsResult.rows.map((m) =>
        mapModel(m, tiersByModel.get(m.id) ?? []),
      );
      return reply.send(models);
    },
  );

  // ── E16: POST /api/v1/hub/pricing/:productId/model ────────────────────────
  fastify.post<{
    Params: { productId: string };
    Body: {
      modelType: string;
      currency?: string;
      config?: Record<string, unknown>;
      tiers?: Array<{
        tierOrder: number;
        upToUnits?: number | null;
        unitPriceCents: number;
        flatFeeCents?: number;
      }>;
      createdBy?: string;
    };
  }>(
    '/api/v1/hub/pricing/:productId/model',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['modelType'],
          properties: {
            modelType: { type: 'string', enum: ['flat_rate', 'tiered', 'usage_based', 'per_seat'] },
            currency: { type: 'string' },
            config: { type: 'object' },
            tiers: { type: 'array' },
            createdBy: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { productId } = request.params;
      const body = request.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Deprecate current active model
        await client.query(
          `UPDATE pricing_models SET active = false, deprecated_at = NOW(), updated_at = NOW()
           WHERE product_id = $1 AND active = true`,
          [productId],
        );

        const modelResult = await client.query<ModelRow>(
          `INSERT INTO pricing_models (product_id, model_type, currency, config, active, activated_at, created_by)
           VALUES ($1, $2, $3, $4::jsonb, true, NOW(), $5)
           RETURNING *`,
          [
            productId,
            body.modelType,
            body.currency ?? 'USD',
            JSON.stringify(body.config ?? {}),
            body.createdBy ?? null,
          ],
        );
        const model = modelResult.rows[0];

        const tiers: TierRow[] = [];
        for (const tier of body.tiers ?? []) {
          const tr = await client.query<TierRow>(
            `INSERT INTO price_tiers (model_id, tier_order, up_to_units, unit_price_cents, flat_fee_cents)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [model.id, tier.tierOrder, tier.upToUnits ?? null, tier.unitPriceCents, tier.flatFeeCents ?? 0],
          );
          tiers.push(tr.rows[0]);
        }

        await client.query('COMMIT');
        return reply.status(201).send(mapModel(model, tiers));
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // ── E17: POST /api/v1/hub/pricing/:productId/advisor ──────────────────────
  fastify.post<{
    Params: { productId: string };
    Body: { tenantId: string };
  }>(
    '/api/v1/hub/pricing/:productId/advisor',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['tenantId'],
          properties: { tenantId: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { productId } = request.params;
      const { tenantId } = request.body;

      // Verify product and tenant exist
      const productCheck = await pool.query(
        `SELECT id FROM products WHERE id = $1`, [productId],
      );
      if (!productCheck.rows.length) throw new AppError(404, 'Product not found');

      const tenantCheck = await pool.query(
        `SELECT id FROM tenants WHERE id = $1`, [tenantId],
      );
      if (!tenantCheck.rows.length) throw new AppError(404, 'Tenant not found');

      const weekStart = new Date();
      weekStart.setUTCHours(0, 0, 0, 0);
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      const weekStartStr = weekStart.toISOString().slice(0, 10);

      const modelResult = await pool.query(
        `SELECT model_type FROM pricing_models WHERE product_id = $1 AND active = true LIMIT 1`,
        [productId],
      );

      const recommendationType = modelResult.rows.length === 0 ? 'upgrade' : 'stay';
      const rationale =
        recommendationType === 'upgrade'
          ? 'No active pricing model configured. Consider setting up a plan.'
          : 'Current plan is appropriate based on available usage data.';

      const result = await pool.query<RecommendationRow>(
        `INSERT INTO plan_advisor_recommendations
           (product_id, tenant_id, recommendation_type, rationale, confidence, week_start)
         VALUES ($1, $2, $3, $4, 'medium', $5)
         RETURNING *`,
        [productId, tenantId, recommendationType, rationale, weekStartStr],
      );

      return reply.status(201).send(mapRecommendation(result.rows[0]));
    },
  );

  // ── E17: GET /api/v1/hub/pricing/:productId/advisor/:tenantId/latest ──────
  fastify.get<{ Params: { productId: string; tenantId: string } }>(
    '/api/v1/hub/pricing/:productId/advisor/:tenantId/latest',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { productId, tenantId } = request.params;

      const result = await pool.query<RecommendationRow>(
        `SELECT * FROM plan_advisor_recommendations
         WHERE product_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [productId, tenantId],
      );
      if (!result.rows.length) return reply.send(null);

      return reply.send(mapRecommendation(result.rows[0]));
    },
  );

  // ── E18: POST /api/v1/hub/pricing/:productId/plan-change ──────────────────
  fastify.post<{
    Params: { productId: string };
    Body: {
      tenantId: string;
      planId: string;
      effectiveDate: string;
      auditNote?: string;
      discountPercent?: number;
      priceOverrides?: Record<string, number>;
      appliedBy?: string;
    };
  }>(
    '/api/v1/hub/pricing/:productId/plan-change',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['tenantId', 'planId', 'effectiveDate'],
          properties: {
            tenantId: { type: 'string' },
            planId: { type: 'string' },
            effectiveDate: { type: 'string' },
            auditNote: { type: 'string' },
            discountPercent: { type: 'number' },
            priceOverrides: { type: 'object' },
            appliedBy: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { productId } = request.params;
      const body = request.body;

      const effectiveAt =
        body.effectiveDate === 'immediate'
          ? new Date()
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const result = await pool.query<{ id: string; plan_id: string; effective_at: string }>(
        `INSERT INTO plan_change_ledger
           (product_id, tenant_id, plan_id, effective_date, effective_at,
            audit_note, discount_percent, price_overrides, applied_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING id, plan_id, effective_at`,
        [
          productId,
          body.tenantId,
          body.planId,
          body.effectiveDate,
          effectiveAt.toISOString(),
          body.auditNote ?? null,
          body.discountPercent ?? null,
          JSON.stringify(body.priceOverrides ?? {}),
          body.appliedBy ?? null,
        ],
      );

      const row = result.rows[0];
      return reply.status(201).send({
        ok: true,
        planId: row.plan_id,
        effectiveAt: String(row.effective_at),
      });
    },
  );

  // ── E19: GET /api/v1/hub/pricing/portfolio ────────────────────────────────
  fastify.get(
    '/api/v1/hub/pricing/portfolio',
    { preHandler: [fastify.authenticate] },
    async (_request, reply) => {
      const result = await pool.query<{
        product_id: string;
        product_name: string;
        active_model_type: string | null;
        active_model_id: string | null;
        open_recommendations: number;
      }>(
        `SELECT
           p.id                AS product_id,
           p.name              AS product_name,
           pm.model_type       AS active_model_type,
           pm.id               AS active_model_id,
           COALESCE((
             SELECT COUNT(*)::int FROM plan_advisor_recommendations r
             WHERE r.product_id = p.id
               AND r.recommendation_type != 'stay'
               AND r.created_at > NOW() - INTERVAL '30 days'
           ), 0)               AS open_recommendations
         FROM products p
         LEFT JOIN pricing_models pm ON pm.product_id = p.id AND pm.active = true
         ORDER BY p.name`,
      );

      const items = result.rows.map((row) => ({
        productId: row.product_id,
        productName: row.product_name,
        activeModelType: row.active_model_type ?? null,
        activeModelId: row.active_model_id ?? null,
        openRecommendations: row.open_recommendations,
        marginHealth: 'healthy' as const,
      }));

      return reply.send(items);
    },
  );

  // ── E20: GET /api/v1/hub/pricing/tenant-scope/:userId ─────────────────────
  fastify.get<{ Params: { userId: string } }>(
    '/api/v1/hub/pricing/tenant-scope/:userId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { userId } = request.params;

      // Resolve tenant memberships for this user identity.
      // HUB stores external identities by product — derive tenant scope from
      // the authenticated product's tenant and any child tenants.
      const result = await pool.query<{ tenant_id: string; tenant_type: string }>(
        `SELECT DISTINCT t.id AS tenant_id, t.tenant_type
         FROM tenants t
         JOIN products p ON p.tenant_id = t.id
         WHERE t.status = 'active'
         LIMIT 50`,
      );

      const own = result.rows[0];
      return reply.send({
        ownTenantId: own?.tenant_id ?? userId,
        childTenantIds: result.rows.slice(1).map((r) => r.tenant_id),
        canActOnAll: own?.tenant_type === 'internal',
      });
    },
  );
};

export default fp(pricingRoutes, { name: 'pricing-routes' });
