// Authorized by HUB-1146 — GET /api/v1/admin/console/pricing/:productId/overview
// Authorized by HUB-1147 — tenant list, plan assignment (single + bulk), discounts, overrides, audit log
// Authorized by HUB-1697 (E-BE-1 S20) — audit-log endpoint extended with actor/action/entity_type/
//   from/to/sort filters and per-product RBAC enforcement for product_admin. Backing table stays
//   on `operator_audit_log` (HUB-1147 era; story's generic "audit_log" naming clarified in service
//   layer). product_admin scope uses tenant_id (no scoped_products JWT claim exists in v0.1);
//   requested product_id must belong to operator's tenant via products.tenant_id match.
// Authorized by HUB-1700 (E-BE-1 S23) — GET /api/v1/admin/portfolio/products portfolio-wide
//   products endpoint. RBAC: super_admin returns all products; product_admin returns products
//   where tenant_id = operator.tenant_id (single-tenant model — matches assertTenantAccess in
//   products.ts). v0.1 scoping model LOCKED: NO scoped_products[] JWT claim expansion (D-HUB-
//   SCOPE-035 v0.1 lock). v0.2 candidate if multi-product operators emerge. No migration
//   needed: products_tenant_name_unique (migration 027) implicitly creates the composite
//   (tenant_id, name) B-tree index the AC#5 lookup pattern relies on.
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
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
import { getPortfolioProducts } from '../../services/portfolioService.js';

const MAX_RANGE_DAYS_AUDIT = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  //
  // HUB-1653 (E-FE-5 S3): VERIFIED that deleteDiscount() is already soft-archive
  // (sets active=false + writes audit_log; see operatorConsoleService.deleteDiscount).
  // No migration required. The GET now accepts ?includeArchived=true so the
  // HUB-1657 FE discount UI can toggle visibility of archived entries.

  fastify.get('/api/v1/admin/console/discounts/:tenantId/:productId', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');

    const q = request.query as Record<string, string | undefined>;
    const includeArchived = q.includeArchived === 'true';
    const discounts = await listDiscounts(tenantId, productId, { includeArchived });
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
  //
  // HUB-1653 (E-FE-5 S3): VERIFIED that deleteOverride() is already soft-archive
  // (sets active=false + writes audit_log; see operatorConsoleService.deleteOverride).
  // No migration required. The GET now accepts ?includeArchived=true so the
  // HUB-1657 FE override UI can toggle visibility of archived entries.

  fastify.get('/api/v1/admin/console/overrides/:tenantId/:productId', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');

    const q = request.query as Record<string, string | undefined>;
    const includeArchived = q.includeArchived === 'true';
    const overrides = await listOverrides(tenantId, productId, { includeArchived });
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

  // ── HUB-1700: Portfolio-wide products (single-tenant RBAC model) ──────────────

  // HUB-1772: handler self-scopes via op.tenant_id; no URL/body/query tenant_id required.
  fastify.get(
    '/api/v1/admin/portfolio/products',
    { config: { operatorSelfScoped: true } },
    async (request, reply) => {
    const op = request.operatorUser;
    const q = request.query as Record<string, string | undefined>;

    let operatorTenantId: string | null = null;
    if (op?.role === 'product_admin') {
      // Defensive: a product_admin JWT with null tenant_id should never reach here,
      // but if mis-issuance happens, fail closed rather than leak all products.
      if (!op.tenant_id) {
        throw new AppError(
          403,
          'FORBIDDEN: product_admin requires a tenant_id claim',
        );
      }
      operatorTenantId = op.tenant_id;
    }

    const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 200);
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);

    const result = await getPortfolioProducts({
      operatorTenantId,
      search: q.search,
      limit,
      offset,
    });
    return reply.status(200).send(result);
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

    // RBAC: per HUB-1697, product_admin must specify product_id and may only query products
    // owned by their tenant. operatorRbacHook already enforces query.tenant_id == claim.tenant_id;
    // this handler adds the product_id presence + tenant-ownership check.
    const op = request.operatorUser;
    if (op?.role === 'product_admin') {
      if (!productId) {
        throw new AppError(
          400,
          'PRODUCT_ID_REQUIRED: product_admin must specify product_id',
        );
      }
      const ownerRes = await getPool().query<{ id: string }>(
        `SELECT id FROM products WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [productId, op.tenant_id],
      );
      if (ownerRes.rows.length === 0) {
        throw new AppError(403, "FORBIDDEN: You do not have access to this product's audit log");
      }
    }

    // sort param: only 'created_at:desc' (default) or 'created_at:asc'
    const sortRaw = q.sort;
    let sort: 'asc' | 'desc' = 'desc';
    if (sortRaw !== undefined) {
      if (sortRaw === 'created_at:desc') sort = 'desc';
      else if (sortRaw === 'created_at:asc') sort = 'asc';
      else throw new AppError(400, 'sort must be created_at:desc or created_at:asc');
    }

    // Date range parsing + validation
    let from: Date | undefined;
    let to: Date | undefined;
    if (q.from !== undefined) {
      from = new Date(q.from);
      if (isNaN(from.getTime())) throw new AppError(400, 'from must be a valid ISO8601 date');
    }
    if (q.to !== undefined) {
      to = new Date(q.to);
      if (isNaN(to.getTime())) throw new AppError(400, 'to must be a valid ISO8601 date');
    }
    if (from && to) {
      if (from.getTime() > to.getTime()) {
        throw new AppError(400, 'INVALID_DATE_RANGE: "from" must be <= "to"');
      }
      if ((to.getTime() - from.getTime()) / MS_PER_DAY > MAX_RANGE_DAYS_AUDIT) {
        throw new AppError(
          400,
          `RANGE_TOO_LARGE: range may not exceed ${MAX_RANGE_DAYS_AUDIT} days`,
        );
      }
    }

    const actions = q.action
      ? q.action.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    const entityTypes = q.entity_type
      ? q.entity_type.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

    const result = await getAuditLog({
      tenantId,
      productId,
      actor: q.actor,
      actions,
      entityTypes,
      from,
      to,
      sort,
      limit,
      offset,
    });
    return reply.send(result);
  });
};

export default adminOperatorConsoleRoutes;
