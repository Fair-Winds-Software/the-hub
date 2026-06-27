// Authorized by HUB-1146 — getPricingOverview(): active model + history in one call
// Authorized by HUB-1147 — tenant list with discount/override badges; plan assignment; discounts; overrides; audit log
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getActivePricingModel, getPricingModelHistory } from './pricingModelService.js';
import type { PricingModelRow } from './pricingModelService.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PricingOverview {
  active_model: PricingModelRow | null;
  history: PricingModelRow[];
}

export interface TenantListItem {
  tenant_id: string;
  tenant_name: string;
  active: boolean;
  has_discount: boolean;
  has_override: boolean;
  current_plan_id: string | null;
}

export interface TenantListResult {
  data: TenantListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface TenantPlanAssignment {
  id: string;
  tenant_id: string;
  product_id: string;
  pricing_model_id: string;
  effective_date_type: 'immediate' | 'next_billing_cycle' | 'custom';
  effective_date: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
}

export interface TenantDiscount {
  id: string;
  tenant_id: string;
  product_id: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: string;
  expiry_date: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
}

export interface TenantPricingOverride {
  id: string;
  tenant_id: string;
  product_id: string;
  metric_name: string;
  unit_price_cents: number;
  active: boolean;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  operator_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  before_value: unknown;
  after_value: unknown;
  notes: string | null;
  tenant_id: string | null;
  product_id: string | null;
  recommendation_id: string | null;
  created_at: string;
}

// ── getPricingOverview ─────────────────────────────────────────────────────────

export async function getPricingOverview(productId: string): Promise<PricingOverview> {
  const [activeModel, historyResult] = await Promise.all([
    getActivePricingModel(productId),
    getPricingModelHistory(productId, 50, 0),
  ]);
  return { active_model: activeModel, history: historyResult.data };
}

// ── getTenantList ──────────────────────────────────────────────────────────────

export async function getTenantList(
  productId: string,
  search: string,
  limit: number,
  offset: number,
): Promise<TenantListResult> {
  const pool = getPool();

  const searchParam = search.trim();

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM tenants t
     WHERE t.active = true
       AND ($1 = '' OR t.name ILIKE '%' || $1 || '%' OR t.id::TEXT ILIKE $1)`,
    [searchParam],
  );

  const total = parseInt(countRows[0]!.count, 10);

  const { rows } = await pool.query<{
    tenant_id: string;
    tenant_name: string;
    active: boolean;
    has_discount: boolean;
    has_override: boolean;
    current_plan_id: string | null;
  }>(
    `SELECT
       t.id AS tenant_id,
       t.name AS tenant_name,
       t.active,
       EXISTS(
         SELECT 1 FROM tenant_discounts d
         WHERE d.tenant_id = t.id AND d.product_id = $2 AND d.active = true
           AND (d.expiry_date IS NULL OR d.expiry_date > NOW())
       ) AS has_discount,
       EXISTS(
         SELECT 1 FROM tenant_pricing_overrides o
         WHERE o.tenant_id = t.id AND o.product_id = $2 AND o.active = true
       ) AS has_override,
       (SELECT pricing_model_id::TEXT FROM tenant_plan_assignments a
        WHERE a.tenant_id = t.id AND a.product_id = $2 AND a.active = true
        ORDER BY a.created_at DESC LIMIT 1) AS current_plan_id
     FROM tenants t
     WHERE t.active = true
       AND ($1 = '' OR t.name ILIKE '%' || $1 || '%' OR t.id::TEXT ILIKE $1)
     ORDER BY t.name
     LIMIT $3 OFFSET $4`,
    [searchParam, productId, limit, offset],
  );

  return {
    data: rows.map((r) => ({
      tenant_id: r.tenant_id,
      tenant_name: r.tenant_name,
      active: r.active,
      has_discount: r.has_discount,
      has_override: r.has_override,
      current_plan_id: r.current_plan_id,
    })),
    total,
    limit,
    offset,
  };
}

// ── assignPlan ─────────────────────────────────────────────────────────────────

export interface AssignPlanInput {
  tenantId: string;
  productId: string;
  pricingModelId: string;
  effectiveDateType: 'immediate' | 'next_billing_cycle' | 'custom';
  effectiveDate?: string;
  notes?: string;
  operatorId?: string;
}

async function writeAuditLog(
  action: string,
  entityType: string,
  entityId: string,
  opts: {
    operatorId?: string;
    tenantId?: string;
    productId?: string;
    recommendationId?: string;
    beforeValue?: unknown;
    afterValue?: unknown;
    notes?: string;
  },
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO operator_audit_log
       (operator_id, entity_type, entity_id, action, before_value, after_value, notes, tenant_id, product_id, recommendation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      opts.operatorId ?? null,
      entityType,
      entityId,
      action,
      opts.beforeValue !== undefined ? JSON.stringify(opts.beforeValue) : null,
      opts.afterValue !== undefined ? JSON.stringify(opts.afterValue) : null,
      opts.notes ?? null,
      opts.tenantId ?? null,
      opts.productId ?? null,
      opts.recommendationId ?? null,
    ],
  );
}

export async function assignPlan(input: AssignPlanInput): Promise<TenantPlanAssignment> {
  const pool = getPool();

  // Verify the pricing model exists for this product
  const { rows: modelRows } = await pool.query<{ id: string }>(
    `SELECT id FROM pricing_models WHERE id = $1 AND product_id = $2`,
    [input.pricingModelId, input.productId],
  );
  if (modelRows.length === 0) {
    throw new AppError(404, 'Pricing model not found for this product');
  }

  // Deactivate previous assignments
  await pool.query(
    `UPDATE tenant_plan_assignments SET active = false, updated_at = NOW()
     WHERE tenant_id = $1 AND product_id = $2 AND active = true`,
    [input.tenantId, input.productId],
  );

  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    product_id: string;
    pricing_model_id: string;
    effective_date_type: 'immediate' | 'next_billing_cycle' | 'custom';
    effective_date: Date | null;
    notes: string | null;
    active: boolean;
    created_at: Date;
  }>(
    `INSERT INTO tenant_plan_assignments
       (tenant_id, product_id, pricing_model_id, effective_date_type, effective_date, assigned_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.tenantId,
      input.productId,
      input.pricingModelId,
      input.effectiveDateType,
      input.effectiveDate ?? null,
      input.operatorId ?? null,
      input.notes ?? null,
    ],
  );

  const row = rows[0]!;

  await writeAuditLog('plan_assigned', 'tenant_plan_assignment', row.id, {
    operatorId: input.operatorId,
    tenantId: input.tenantId,
    productId: input.productId,
    afterValue: { pricing_model_id: input.pricingModelId, effective_date_type: input.effectiveDateType },
    notes: input.notes,
  });

  logger.info(
    { tenantId: input.tenantId, productId: input.productId, modelId: input.pricingModelId },
    'Plan assigned',
  );

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    product_id: row.product_id,
    pricing_model_id: row.pricing_model_id,
    effective_date_type: row.effective_date_type,
    effective_date: row.effective_date ? row.effective_date.toISOString() : null,
    notes: row.notes,
    active: row.active,
    created_at: row.created_at.toISOString(),
  };
}

// ── assignPlanBulk ─────────────────────────────────────────────────────────────

export interface AssignPlanBulkInput {
  tenantIds: string[];
  productId: string;
  pricingModelId: string;
  effectiveDateType: 'immediate' | 'next_billing_cycle' | 'custom';
  effectiveDate?: string;
  operatorId?: string;
}

export interface BulkAssignResult {
  succeeded: string[];
  failed: Array<{ tenant_id: string; error: string }>;
}

export async function assignPlanBulk(input: AssignPlanBulkInput): Promise<BulkAssignResult> {
  if (input.tenantIds.length > 50) {
    throw new AppError(400, 'Bulk assignment supports a maximum of 50 tenants at a time');
  }

  const results = await Promise.allSettled(
    input.tenantIds.map((tenantId) =>
      assignPlan({
        tenantId,
        productId: input.productId,
        pricingModelId: input.pricingModelId,
        effectiveDateType: input.effectiveDateType,
        effectiveDate: input.effectiveDate,
        operatorId: input.operatorId,
      }),
    ),
  );

  const succeeded: string[] = [];
  const failed: Array<{ tenant_id: string; error: string }> = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const tenantId = input.tenantIds[i]!;
    if (result.status === 'fulfilled') {
      succeeded.push(tenantId);
    } else {
      failed.push({ tenant_id: tenantId, error: (result.reason as Error).message });
    }
  }

  logger.info(
    { productId: input.productId, succeeded: succeeded.length, failed: failed.length },
    'Bulk plan assignment complete',
  );

  return { succeeded, failed };
}

// ── listDiscounts / applyDiscount / deleteDiscount ─────────────────────────────

export async function listDiscounts(
  tenantId: string,
  productId: string,
): Promise<TenantDiscount[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    product_id: string;
    discount_type: 'percentage' | 'fixed';
    discount_value: string;
    expiry_date: Date | null;
    notes: string | null;
    active: boolean;
    created_at: Date;
  }>(
    `SELECT id, tenant_id, product_id, discount_type, discount_value::TEXT,
            expiry_date, notes, active, created_at
     FROM tenant_discounts
     WHERE tenant_id = $1 AND product_id = $2 AND active = true
     ORDER BY created_at DESC`,
    [tenantId, productId],
  );

  return rows.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    product_id: r.product_id,
    discount_type: r.discount_type,
    discount_value: r.discount_value,
    expiry_date: r.expiry_date ? r.expiry_date.toISOString() : null,
    notes: r.notes,
    active: r.active,
    created_at: r.created_at.toISOString(),
  }));
}

export interface ApplyDiscountInput {
  tenantId: string;
  productId: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  expiryDate?: string;
  notes?: string;
  operatorId?: string;
}

export async function applyDiscount(input: ApplyDiscountInput): Promise<TenantDiscount> {
  const pool = getPool();

  if (input.discountType === 'percentage' && (input.discountValue <= 0 || input.discountValue > 100)) {
    throw new AppError(400, 'Percentage discount must be between 0 and 100');
  }
  if (input.discountValue <= 0) {
    throw new AppError(400, 'Discount value must be greater than 0');
  }

  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    product_id: string;
    discount_type: 'percentage' | 'fixed';
    discount_value: string;
    expiry_date: Date | null;
    notes: string | null;
    active: boolean;
    created_at: Date;
  }>(
    `INSERT INTO tenant_discounts
       (tenant_id, product_id, discount_type, discount_value, expiry_date, notes, applied_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, product_id, discount_type, discount_value::TEXT,
               expiry_date, notes, active, created_at`,
    [
      input.tenantId,
      input.productId,
      input.discountType,
      input.discountValue,
      input.expiryDate ?? null,
      input.notes ?? null,
      input.operatorId ?? null,
    ],
  );

  const row = rows[0]!;

  await writeAuditLog('discount_applied', 'tenant_discount', row.id, {
    operatorId: input.operatorId,
    tenantId: input.tenantId,
    productId: input.productId,
    afterValue: { discount_type: input.discountType, discount_value: input.discountValue },
    notes: input.notes,
  });

  logger.info({ tenantId: input.tenantId, productId: input.productId, type: input.discountType }, 'Discount applied');

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    product_id: row.product_id,
    discount_type: row.discount_type,
    discount_value: row.discount_value,
    expiry_date: row.expiry_date ? row.expiry_date.toISOString() : null,
    notes: row.notes,
    active: row.active,
    created_at: row.created_at.toISOString(),
  };
}

export async function deleteDiscount(discountId: string, operatorId?: string): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query<{ tenant_id: string; product_id: string; discount_type: string; discount_value: string }>(
    `UPDATE tenant_discounts
     SET active = false, updated_at = NOW()
     WHERE id = $1 AND active = true
     RETURNING tenant_id, product_id, discount_type, discount_value::TEXT`,
    [discountId],
  );

  if (rows.length === 0) {
    throw new AppError(404, 'Discount not found or already inactive');
  }

  const row = rows[0]!;

  await writeAuditLog('discount_removed', 'tenant_discount', discountId, {
    operatorId,
    tenantId: row.tenant_id,
    productId: row.product_id,
    beforeValue: { discount_type: row.discount_type, discount_value: row.discount_value },
  });

  logger.info({ discountId }, 'Discount removed');
}

// ── listOverrides / applyOverride / deleteOverride ────────────────────────────

export async function listOverrides(
  tenantId: string,
  productId: string,
): Promise<TenantPricingOverride[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    product_id: string;
    metric_name: string;
    unit_price_cents: number;
    active: boolean;
    created_at: Date;
  }>(
    `SELECT id, tenant_id, product_id, metric_name, unit_price_cents, active, created_at
     FROM tenant_pricing_overrides
     WHERE tenant_id = $1 AND product_id = $2 AND active = true
     ORDER BY metric_name`,
    [tenantId, productId],
  );

  return rows.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    product_id: r.product_id,
    metric_name: r.metric_name,
    unit_price_cents: r.unit_price_cents,
    active: r.active,
    created_at: r.created_at.toISOString(),
  }));
}

export interface ApplyOverrideInput {
  tenantId: string;
  productId: string;
  metricName: string;
  unitPriceCents: number;
  operatorId?: string;
}

export async function applyOverride(input: ApplyOverrideInput): Promise<TenantPricingOverride> {
  const pool = getPool();

  if (input.unitPriceCents < 0) {
    throw new AppError(400, 'unit_price_cents must be >= 0');
  }

  // Fetch before value for audit
  const { rows: before } = await pool.query<{ unit_price_cents: number }>(
    `SELECT unit_price_cents FROM tenant_pricing_overrides
     WHERE tenant_id = $1 AND product_id = $2 AND metric_name = $3 AND active = true`,
    [input.tenantId, input.productId, input.metricName],
  );

  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    product_id: string;
    metric_name: string;
    unit_price_cents: number;
    active: boolean;
    created_at: Date;
  }>(
    `INSERT INTO tenant_pricing_overrides
       (tenant_id, product_id, metric_name, unit_price_cents, applied_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, product_id, metric_name) DO UPDATE
       SET unit_price_cents = EXCLUDED.unit_price_cents,
           applied_by       = EXCLUDED.applied_by,
           active           = true,
           updated_at       = NOW()
     RETURNING id, tenant_id, product_id, metric_name, unit_price_cents, active, created_at`,
    [input.tenantId, input.productId, input.metricName, input.unitPriceCents, input.operatorId ?? null],
  );

  const row = rows[0]!;

  await writeAuditLog('override_applied', 'tenant_pricing_override', row.id, {
    operatorId: input.operatorId,
    tenantId: input.tenantId,
    productId: input.productId,
    beforeValue: before[0] ?? null,
    afterValue: { metric_name: input.metricName, unit_price_cents: input.unitPriceCents },
  });

  logger.info(
    { tenantId: input.tenantId, productId: input.productId, metric: input.metricName },
    'Pricing override applied',
  );

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    product_id: row.product_id,
    metric_name: row.metric_name,
    unit_price_cents: row.unit_price_cents,
    active: row.active,
    created_at: row.created_at.toISOString(),
  };
}

export async function deleteOverride(overrideId: string, operatorId?: string): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query<{ tenant_id: string; product_id: string; metric_name: string; unit_price_cents: number }>(
    `UPDATE tenant_pricing_overrides
     SET active = false, updated_at = NOW()
     WHERE id = $1 AND active = true
     RETURNING tenant_id, product_id, metric_name, unit_price_cents`,
    [overrideId],
  );

  if (rows.length === 0) {
    throw new AppError(404, 'Override not found or already inactive');
  }

  const row = rows[0]!;

  await writeAuditLog('override_removed', 'tenant_pricing_override', overrideId, {
    operatorId,
    tenantId: row.tenant_id,
    productId: row.product_id,
    beforeValue: { metric_name: row.metric_name, unit_price_cents: row.unit_price_cents },
  });

  logger.info({ overrideId }, 'Pricing override removed');
}

// ── getAuditLog ───────────────────────────────────────────────────────────────
// HUB-1697 (E-BE-1 S20): extended with actor / actions / entityTypes / from / to / sort.
// Backing table is `operator_audit_log` (HUB-1147 era). Story spec used the generic name
// "audit_log" — there's a separate `audit_log` table (HUB-1516) used by services; this
// endpoint stays on operator_audit_log per the existing E-FE-12 consumer contract.

export async function getAuditLog(opts: {
  tenantId?: string;
  productId?: string;
  actor?: string;
  actions?: string[];
  entityTypes?: string[];
  from?: Date;
  to?: Date;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}): Promise<{ data: AuditLogEntry[]; total: number; limit: number; offset: number }> {
  const pool = getPool();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const sortDir = opts.sort === 'asc' ? 'ASC' : 'DESC';

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.tenantId) {
    conditions.push(`tenant_id = $${idx++}`);
    params.push(opts.tenantId);
  }
  if (opts.productId) {
    conditions.push(`product_id = $${idx++}`);
    params.push(opts.productId);
  }
  // actor: substring match on operator_id::text (UUID column). Spec said "audit_log.actor"
  // — mapped to operator_id per column-deviation note in HUB-1697. ILIKE supports partial
  // UUID prefix lookup for FE typeahead.
  if (opts.actor) {
    conditions.push(`operator_id::text ILIKE $${idx++}`);
    params.push(`%${opts.actor}%`);
  }
  if (opts.actions && opts.actions.length > 0) {
    conditions.push(`action = ANY($${idx++}::text[])`);
    params.push(opts.actions);
  }
  if (opts.entityTypes && opts.entityTypes.length > 0) {
    conditions.push(`entity_type = ANY($${idx++}::text[])`);
    params.push(opts.entityTypes);
  }
  if (opts.from) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(opts.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM operator_audit_log ${where}`,
    params,
  );
  const total = parseInt(countRows[0]!.count, 10);

  const { rows } = await pool.query<{
    id: string;
    operator_id: string | null;
    entity_type: string;
    entity_id: string;
    action: string;
    before_value: unknown;
    after_value: unknown;
    notes: string | null;
    tenant_id: string | null;
    product_id: string | null;
    recommendation_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, operator_id, entity_type, entity_id, action,
            before_value, after_value, notes, tenant_id, product_id,
            recommendation_id, created_at
     FROM operator_audit_log
     ${where}
     ORDER BY created_at ${sortDir}
     LIMIT $${idx++} OFFSET $${idx}`,
    [...params, limit, offset],
  );

  return {
    data: rows.map((r) => ({
      id: r.id,
      operator_id: r.operator_id,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      action: r.action,
      before_value: r.before_value,
      after_value: r.after_value,
      notes: r.notes,
      tenant_id: r.tenant_id,
      product_id: r.product_id,
      recommendation_id: r.recommendation_id,
      created_at: r.created_at.toISOString(),
    })),
    total,
    limit,
    offset,
  };
}
