// Authorized by HUB-1146 — GET /api/v1/admin/console/pricing/:productId/overview
// Authorized by HUB-1147 — tenant list, plan assignment (single + bulk), discounts, overrides, audit log
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  getPricingOverview,
  getTenantList,
  assignPlan,
  assignPlanBulk,
  listDiscounts,
  applyDiscount,
  deleteDiscount,
  listOverrides,
  applyOverride,
  deleteOverride,
  getAuditLog,
} from '../../services/operatorConsoleService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

function operatorId(request: { operatorUser?: { operator_id?: string } }): string | undefined {
  return request.operatorUser?.operator_id;
}

const adminOperatorConsoleRoutes: FastifyPluginAsync = async (fastify) => {

  // ── HUB-1146: Pricing overview ───────────────────────────────────────────────

  fastify.get('/api/v1/admin/console/pricing/:productId/overview', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');

    const overview = await getPricingOverview(productId);
    return reply.send(overview);
  });

  // ── HUB-1147: Tenant list ─────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/console/tenants', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;

    const productId = q.product_id ?? '';
    if (!productId || !UUID_RE.test(productId)) {
      throw new AppError(400, 'product_id query param must be a valid UUID');
    }

    const search = q.search ?? '';
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 100);
    const offset = Math.max(parseInt(q.offset ?? '0', 10), 0);

    const result = await getTenantList(productId, search, limit, offset);
    return reply.send(result);
  });

  // ── HUB-1147: Plan assignment — single tenant ─────────────────────────────────

  fastify.post('/api/v1/admin/console/plans/assign', async (request, reply) => {
    const body = (request.body as Record<string, unknown> | null) ?? {};

    const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : '';
    const productId = typeof body.product_id === 'string' ? body.product_id : '';
    const pricingModelId = typeof body.pricing_model_id === 'string' ? body.pricing_model_id : '';

    if (!tenantId) throw new AppError(400, 'tenant_id is required');
    if (!productId) throw new AppError(400, 'product_id is required');
    if (!pricingModelId) throw new AppError(400, 'pricing_model_id is required');

    assertUUID(tenantId, 'tenant_id');
    assertUUID(productId, 'product_id');
    assertUUID(pricingModelId, 'pricing_model_id');

    const effectiveDateType = typeof body.effective_date_type === 'string'
      ? body.effective_date_type
      : 'immediate';

    const VALID_EDT = new Set(['immediate', 'next_billing_cycle', 'custom']);
    if (!VALID_EDT.has(effectiveDateType)) {
      throw new AppError(400, 'effective_date_type must be immediate, next_billing_cycle, or custom');
    }

    if (effectiveDateType === 'custom' && typeof body.effective_date !== 'string') {
      throw new AppError(400, 'effective_date is required when effective_date_type is custom');
    }

    const assignment = await assignPlan({
      tenantId,
      productId,
      pricingModelId,
      effectiveDateType: effectiveDateType as 'immediate' | 'next_billing_cycle' | 'custom',
      effectiveDate: typeof body.effective_date === 'string' ? body.effective_date : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      operatorId: operatorId(request),
    });

    return reply.status(201).send(assignment);
  });

  // ── HUB-1147: Plan assignment — bulk (up to 50 tenants) ──────────────────────

  fastify.post('/api/v1/admin/console/plans/assign/bulk', async (request, reply) => {
    const body = (request.body as Record<string, unknown> | null) ?? {};

    if (!Array.isArray(body.tenant_ids) || body.tenant_ids.length === 0) {
      throw new AppError(400, 'tenant_ids must be a non-empty array');
    }

    const tenantIds = body.tenant_ids as unknown[];
    if (tenantIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
      throw new AppError(400, 'All tenant_ids must be valid UUIDs');
    }

    const productId = typeof body.product_id === 'string' ? body.product_id : '';
    const pricingModelId = typeof body.pricing_model_id === 'string' ? body.pricing_model_id : '';

    if (!productId) throw new AppError(400, 'product_id is required');
    if (!pricingModelId) throw new AppError(400, 'pricing_model_id is required');

    assertUUID(productId, 'product_id');
    assertUUID(pricingModelId, 'pricing_model_id');

    const effectiveDateType = typeof body.effective_date_type === 'string'
      ? body.effective_date_type
      : 'immediate';

    const VALID_EDT = new Set(['immediate', 'next_billing_cycle', 'custom']);
    if (!VALID_EDT.has(effectiveDateType)) {
      throw new AppError(400, 'effective_date_type must be immediate, next_billing_cycle, or custom');
    }

    const result = await assignPlanBulk({
      tenantIds: tenantIds as string[],
      productId,
      pricingModelId,
      effectiveDateType: effectiveDateType as 'immediate' | 'next_billing_cycle' | 'custom',
      effectiveDate: typeof body.effective_date === 'string' ? body.effective_date : undefined,
      operatorId: operatorId(request),
    });

    return reply.status(207).send(result);
  });

  // ── HUB-1147: Discounts ───────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/console/discounts/:tenantId/:productId', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');

    const discounts = await listDiscounts(tenantId, productId);
    return reply.send({ data: discounts });
  });

  fastify.post('/api/v1/admin/console/discounts', async (request, reply) => {
    const body = (request.body as Record<string, unknown> | null) ?? {};

    const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : '';
    const productId = typeof body.product_id === 'string' ? body.product_id : '';
    const discountType = typeof body.discount_type === 'string' ? body.discount_type : '';
    const discountValue = typeof body.discount_value === 'number' ? body.discount_value : NaN;

    if (!tenantId) throw new AppError(400, 'tenant_id is required');
    if (!productId) throw new AppError(400, 'product_id is required');
    if (!discountType) throw new AppError(400, 'discount_type is required');
    if (isNaN(discountValue)) throw new AppError(400, 'discount_value must be a number');

    assertUUID(tenantId, 'tenant_id');
    assertUUID(productId, 'product_id');

    if (!['percentage', 'fixed'].includes(discountType)) {
      throw new AppError(400, 'discount_type must be percentage or fixed');
    }

    const discount = await applyDiscount({
      tenantId,
      productId,
      discountType: discountType as 'percentage' | 'fixed',
      discountValue,
      expiryDate: typeof body.expiry_date === 'string' ? body.expiry_date : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      operatorId: operatorId(request),
    });

    return reply.status(201).send(discount);
  });

  fastify.delete('/api/v1/admin/console/discounts/:discountId', async (request, reply) => {
    const { discountId } = request.params as { discountId: string };
    assertUUID(discountId, 'discountId');

    await deleteDiscount(discountId, operatorId(request));
    return reply.status(204).send();
  });

  // ── HUB-1147: Pricing overrides ───────────────────────────────────────────────

  fastify.get('/api/v1/admin/console/overrides/:tenantId/:productId', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');

    const overrides = await listOverrides(tenantId, productId);
    return reply.send({ data: overrides });
  });

  fastify.post('/api/v1/admin/console/overrides', async (request, reply) => {
    const body = (request.body as Record<string, unknown> | null) ?? {};

    const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : '';
    const productId = typeof body.product_id === 'string' ? body.product_id : '';
    const metricName = typeof body.metric_name === 'string' ? body.metric_name : '';
    const unitPriceCents = typeof body.unit_price_cents === 'number' ? body.unit_price_cents : NaN;

    if (!tenantId) throw new AppError(400, 'tenant_id is required');
    if (!productId) throw new AppError(400, 'product_id is required');
    if (!metricName) throw new AppError(400, 'metric_name is required');
    if (isNaN(unitPriceCents)) throw new AppError(400, 'unit_price_cents must be a number');

    assertUUID(tenantId, 'tenant_id');
    assertUUID(productId, 'product_id');

    const override = await applyOverride({
      tenantId,
      productId,
      metricName,
      unitPriceCents: Math.round(unitPriceCents),
      operatorId: operatorId(request),
    });

    return reply.status(201).send(override);
  });

  fastify.delete('/api/v1/admin/console/overrides/:overrideId', async (request, reply) => {
    const { overrideId } = request.params as { overrideId: string };
    assertUUID(overrideId, 'overrideId');

    await deleteOverride(overrideId, operatorId(request));
    return reply.status(204).send();
  });

  // ── HUB-1147: Audit log ───────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/console/audit-log', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;

    const tenantId = q.tenant_id;
    const productId = q.product_id;
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 200);
    const offset = Math.max(parseInt(q.offset ?? '0', 10), 0);

    if (tenantId && !UUID_RE.test(tenantId)) throw new AppError(400, 'tenant_id must be a valid UUID');
    if (productId && !UUID_RE.test(productId)) throw new AppError(400, 'product_id must be a valid UUID');

    const result = await getAuditLog({ tenantId, productId, limit, offset });
    return reply.send(result);
  });
};

export default adminOperatorConsoleRoutes;
