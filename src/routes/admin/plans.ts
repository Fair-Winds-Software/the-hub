// Authorized by HUB-1651 (E-FE-5 S1) — admin plans CRUD.
// Authorized by HUB-1766 (E-V2-PP-5 S7, HUB-1729, HUB-1701) — accept
// quota_sub_unlocks[] on PUT; enrich GET with quota_sub_unlocks per plan.
//
// Wires the existing planCatalogService.ts primitives + the new
// updatePlan / softArchivePlan extensions from HUB-1651 into 4 REST
// endpoints consumed by the HUB-1655 New Plan modal + plans list UI.
//
// Endpoints (all sit inside adminRoutesPlugin's RBAC scope):
//   GET    /api/v1/admin/plans?productId=<uuid>&includeArchived=false
//   POST   /api/v1/admin/plans           { productId, key, name, billing_type, billing_interval, unit_amount_cents, billing_mode? }
//   PUT    /api/v1/admin/plans/:planId   { name?, description?, unit_amount_cents?, billing_mode?,
//                                           volume_ladder?, first_n_free_quantity?, quantity_metered_dimension? }
//   DELETE /api/v1/admin/plans/:planId   → soft archive (422 if active subscribers)
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Migration filename: spec named 050_plans_archived_at.sql. 050 is
//      already taken by 050_role_rename_step3.sql; new migration is 056
//      per the standing +1 shift pattern (see 046_billing_mode.sql).
//
//   2. billing_mode on POST: createPlan() in the service does NOT take a
//      billing_mode parameter (plans default to 'standard' at insert per
//      046_billing_mode.sql). If the operator specifies billing_mode='credit'
//      at creation time, this route does createPlan() first (which cuts
//      Stripe artifacts) then immediately calls updatePlanBillingMode() to
//      flip. Wasted Stripe artifacts for credit-mode plans are acceptable
//      per D-HUB-SCOPE (no revert path once flipped) — the FE 2-step
//      confirm in HUB-1655 is the guardrail against accidental credit-mode
//      plan creation.
//
//   3. Soft-archive semantics: archived_at IS NULL is the new canonical
//      "active" predicate (migration 056). The pre-existing `active`
//      column stays for backward compatibility; softArchivePlan() sets
//      BOTH atomically inside the same UPDATE. Reads via this route's GET
//      filter on archived_at IS NULL when includeArchived=false.
//
//   4. Audit surface: every mutation writes an audit_log entry via
//      writeAuditEntry (operation ∈ INSERT|UPDATE|DELETE, table_name='plans',
//      record_id=planId, actor_id=<operator JWT operator_id>). writeAuditEntry
//      never throws per its own contract; failures land in the logger.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import {
  createPlan,
  getPlans,
  getPlanById,
  updatePlan,
  updatePlanBillingMode,
  softArchivePlan,
  type BillingMode,
  type BillingType,
  type BillingInterval,
  type SoftArchivePlanError422,
} from '../../services/planCatalogService.js';
import { writeAuditEntry } from '../../services/auditLogService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(v: string, label: string): void {
  if (!UUID_RE.test(v)) throw new AppError(400, `${label} must be a valid UUID`);
}

function actorId(request: FastifyRequest): string | null {
  return request.operatorUser?.operator_id ?? null;
}

async function assertProductAccess(
  request: FastifyRequest,
  productId: string,
): Promise<{ tenantId: string }> {
  assertUUID(productId, 'productId');
  const op = request.operatorUser!;
  const { rows } = await getPool().query<{ tenant_id: string }>(
    'SELECT tenant_id FROM products WHERE id = $1',
    [productId],
  );
  if (!rows[0]) throw new AppError(404, 'Product not found');
  const tenantId = rows[0].tenant_id;
  if (op.role === 'product_admin' && op.tenant_id !== tenantId) {
    throw new AppError(403, 'Forbidden');
  }
  return { tenantId };
}

async function assertPlanAccess(
  request: FastifyRequest,
  planId: string,
): Promise<{ tenantId: string; productId: string }> {
  assertUUID(planId, 'planId');
  const op = request.operatorUser!;
  const { rows } = await getPool().query<{ product_id: string; tenant_id: string }>(
    `SELECT pl.product_id AS product_id, pr.tenant_id AS tenant_id
       FROM plans pl
       JOIN products pr ON pr.id = pl.product_id
      WHERE pl.id = $1`,
    [planId],
  );
  if (!rows[0]) throw new AppError(404, 'Plan not found');
  if (op.role === 'product_admin' && op.tenant_id !== rows[0].tenant_id) {
    throw new AppError(403, 'Forbidden');
  }
  return { tenantId: rows[0].tenant_id, productId: rows[0].product_id };
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

function readOptionalNumber(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = body[key];
  return typeof v === 'number' ? v : undefined;
}

const VALID_BILLING_TYPES: BillingType[] = [
  'flat_rate',
  'per_seat',
  'metered',
  'tiered',
  'one_time',
];
const VALID_BILLING_INTERVALS: BillingInterval[] = [
  'month',
  'quarter',
  'year',
  'one_time',
];
const VALID_BILLING_MODES: BillingMode[] = ['standard', 'credit'];

const adminPlansRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET list ──────────────────────────────────────────────────────────
  fastify.get('/api/v1/admin/plans', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const productId = q.productId ?? '';
    await assertProductAccess(request, productId);
    const includeArchived = q.includeArchived === 'true';
    const plans = await getPlans(productId, { includeArchived });
    // HUB-1745 (E-V2-PP-3 S5) — attach `dimensions[]` per plan so consumers can
    // author the Synapz multi-dimension shape via the same GET/PUT contract.
    const pool = getPool();
    const planIds = plans.map((p) => p.id);
    let dimensionsByPlan = new Map<string, Array<{ dimension_key: string; dimension_label: string; sort_order: number }>>();
    if (planIds.length > 0) {
      const { rows } = await pool.query<{
        plan_id: string; dimension_key: string; dimension_label: string; sort_order: number;
      }>(
        `SELECT plan_id, dimension_key, dimension_label, sort_order
           FROM plan_metered_dimensions
          WHERE plan_id = ANY($1::uuid[])
          ORDER BY sort_order ASC, dimension_key ASC`,
        [planIds],
      );
      for (const r of rows) {
        if (!dimensionsByPlan.has(r.plan_id)) dimensionsByPlan.set(r.plan_id, []);
        dimensionsByPlan.get(r.plan_id)!.push({
          dimension_key: r.dimension_key,
          dimension_label: r.dimension_label,
          sort_order: r.sort_order,
        });
      }
    }
    // HUB-1766 (E-V2-PP-5 S7) — attach quota_sub_unlocks[] per plan.
    let subUnlocksByPlan = new Map<string, Array<{ dimension_key: string; per_month_quantity: number }>>();
    if (planIds.length > 0) {
      const { rows: suRows } = await pool.query<{
        plan_id: string; dimension_key: string; per_month_quantity: number;
      }>(
        `SELECT plan_id, dimension_key, per_month_quantity
           FROM plan_quota_sub_unlocks
          WHERE plan_id = ANY($1::uuid[])
          ORDER BY dimension_key ASC`,
        [planIds],
      );
      for (const r of suRows) {
        if (!subUnlocksByPlan.has(r.plan_id)) subUnlocksByPlan.set(r.plan_id, []);
        subUnlocksByPlan.get(r.plan_id)!.push({
          dimension_key: r.dimension_key,
          per_month_quantity: r.per_month_quantity,
        });
      }
    }
    const enriched = plans.map((p) => ({
      ...p,
      dimensions: dimensionsByPlan.get(p.id) ?? [],
      quota_sub_unlocks: subUnlocksByPlan.get(p.id) ?? [],
    }));
    return reply.send({ data: enriched, total: enriched.length });
  });

  // ── POST create ───────────────────────────────────────────────────────
  fastify.post('/api/v1/admin/plans', async (request, reply) => {
    const body = (request.body as Record<string, unknown> | null) ?? {};
    const productId = readString(body, 'productId') ?? '';
    await assertProductAccess(request, productId);

    const key = readString(body, 'key');
    const name = readString(body, 'name');
    const billingTypeRaw = readString(body, 'billing_type');
    const billingIntervalRaw = readString(body, 'billing_interval');
    const unitAmountCents = readOptionalNumber(body, 'unit_amount_cents');
    const billingModeRaw = readString(body, 'billing_mode');

    if (!key) throw new AppError(400, 'key is required');
    if (!name) throw new AppError(400, 'name is required');
    if (!billingTypeRaw || !VALID_BILLING_TYPES.includes(billingTypeRaw as BillingType)) {
      throw new AppError(400, `billing_type must be one of ${VALID_BILLING_TYPES.join('|')}`);
    }
    if (
      billingIntervalRaw !== undefined &&
      !VALID_BILLING_INTERVALS.includes(billingIntervalRaw as BillingInterval)
    ) {
      throw new AppError(
        400,
        `billing_interval must be one of ${VALID_BILLING_INTERVALS.join('|')}`,
      );
    }
    if (
      billingModeRaw !== undefined &&
      !VALID_BILLING_MODES.includes(billingModeRaw as BillingMode)
    ) {
      throw new AppError(
        400,
        `billing_mode must be one of ${VALID_BILLING_MODES.join('|')}`,
      );
    }

    const plan = await createPlan(productId, {
      key,
      name,
      billingType: billingTypeRaw as BillingType,
      billingInterval: (billingIntervalRaw as BillingInterval) ?? undefined,
      unitAmountCents: unitAmountCents ?? undefined,
    });

    // Spec deviation #2: if operator asked for credit-mode at create time,
    // flip after creation. The flip writes its own audit entry.
    if (billingModeRaw === 'credit') {
      await updatePlanBillingMode(plan.id, 'credit', actorId(request) ?? '');
    }

    await writeAuditEntry({
      tenant_id: '00000000-0000-0000-0000-0000000000a1',
      product_id: productId,
      actor_id: actorId(request),
      actor_type: 'operator',
      operation: 'INSERT',
      table_name: 'plans',
      record_id: plan.id,
      old_values: null,
      new_values: {
        key: plan.key,
        name: plan.name,
        billing_type: plan.billing_type,
        billing_interval: plan.billing_interval,
        unit_amount_cents: plan.unit_amount_cents,
        billing_mode: billingModeRaw ?? 'standard',
      },
    });

    // Re-fetch to include the post-flip billing_mode when applicable.
    const fresh = await getPlanById(plan.id);
    return reply.status(201).send(fresh);
  });

  // ── PUT update ────────────────────────────────────────────────────────
  //
  // HUB-1718/1715/1716 (E-V2-PP-1) supplement: accepts LaunchKit pricing primitive
  // fields on the PUT payload:
  //   volume_ladder: JSONB (see plans.volume_ladder in migration 071)
  //   first_n_free_quantity: integer >= 0
  //   quantity_metered_dimension: snake_case string | null
  fastify.put('/api/v1/admin/plans/:planId', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    await assertPlanAccess(request, planId);
    const body = (request.body as Record<string, unknown> | null) ?? {};

    // Cross-field validation for first-N-free / dimension (defense-in-depth over DB).
    const firstNFree = readOptionalNumber(body, 'first_n_free_quantity');
    const meteredDim = 'quantity_metered_dimension' in body
      ? (body['quantity_metered_dimension'] as string | null)
      : undefined;
    if (firstNFree !== undefined) {
      if (!Number.isInteger(firstNFree) || firstNFree < 0) {
        throw new AppError(400, 'first_n_free_quantity must be a non-negative integer');
      }
      if (firstNFree > 0 && meteredDim === null) {
        throw new AppError(
          400,
          'first_n_free_quantity > 0 requires quantity_metered_dimension to be set',
        );
      }
    }
    if (meteredDim !== undefined && meteredDim !== null) {
      if (typeof meteredDim !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(meteredDim)) {
        throw new AppError(
          400,
          'quantity_metered_dimension must be a snake_case string (3–64 chars)',
        );
      }
    }
    const volumeLadder = 'volume_ladder' in body ? body['volume_ladder'] : undefined;
    if (volumeLadder !== undefined && volumeLadder !== null && !Array.isArray(volumeLadder)) {
      throw new AppError(400, 'volume_ladder must be an array or null');
    }

    // HUB-1745 (E-V2-PP-3 S5) — dimensions[] + tiers with overage_rates.
    const tiers = 'tiers' in body ? body['tiers'] : undefined;
    if (tiers !== undefined && tiers !== null && !Array.isArray(tiers)) {
      throw new AppError(400, 'tiers must be an array or null');
    }
    if (Array.isArray(tiers)) {
      // Validate each tier's overage_rates shape (dimension_key snake_case,
      // included_quantity >= 0, rate_per_unit_cents >= 0).
      for (let ti = 0; ti < tiers.length; ti++) {
        const t = tiers[ti] as { overage_rates?: unknown };
        if (t?.overage_rates !== undefined && t.overage_rates !== null) {
          if (!Array.isArray(t.overage_rates)) {
            throw new AppError(400, `tiers[${ti}].overage_rates must be an array`);
          }
          for (let ri = 0; ri < t.overage_rates.length; ri++) {
            const r = t.overage_rates[ri] as {
              dimension_key?: string;
              included_quantity?: number;
              rate_per_unit_cents?: number;
            };
            if (typeof r?.dimension_key !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(r.dimension_key)) {
              throw new AppError(
                400,
                `tiers[${ti}].overage_rates[${ri}].dimension_key must be snake_case`,
              );
            }
            if (typeof r.included_quantity !== 'number' || r.included_quantity < 0) {
              throw new AppError(
                400,
                `tiers[${ti}].overage_rates[${ri}].included_quantity must be >= 0`,
              );
            }
            if (typeof r.rate_per_unit_cents !== 'number' || r.rate_per_unit_cents < 0) {
              throw new AppError(
                400,
                `tiers[${ti}].overage_rates[${ri}].rate_per_unit_cents must be >= 0`,
              );
            }
          }
        }
      }
    }
    const dimensionsRaw = 'dimensions' in body ? body['dimensions'] : undefined;
    let dimensions: Array<{ dimension_key: string; dimension_label: string; sort_order: number }> | undefined;
    if (dimensionsRaw !== undefined) {
      if (!Array.isArray(dimensionsRaw)) {
        throw new AppError(400, 'dimensions must be an array');
      }
      dimensions = [];
      for (let di = 0; di < dimensionsRaw.length; di++) {
        const d = dimensionsRaw[di] as { dimension_key?: string; dimension_label?: string; sort_order?: number };
        if (typeof d?.dimension_key !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(d.dimension_key)) {
          throw new AppError(400, `dimensions[${di}].dimension_key must be snake_case`);
        }
        if (typeof d.dimension_label !== 'string' || d.dimension_label.length === 0) {
          throw new AppError(400, `dimensions[${di}].dimension_label is required`);
        }
        if (typeof d.sort_order !== 'number' || !Number.isInteger(d.sort_order)) {
          throw new AppError(400, `dimensions[${di}].sort_order must be an integer`);
        }
        dimensions.push({
          dimension_key: d.dimension_key,
          dimension_label: d.dimension_label,
          sort_order: d.sort_order,
        });
      }
    }

    // HUB-1766 (E-V2-PP-5 S7) — quota_sub_unlocks[] parse + validate.
    const subUnlocksRaw = 'quota_sub_unlocks' in body ? body['quota_sub_unlocks'] : undefined;
    let quotaSubUnlocks: Array<{ dimension_key: string; per_month_quantity: number }> | undefined;
    if (subUnlocksRaw !== undefined) {
      if (!Array.isArray(subUnlocksRaw)) {
        throw new AppError(400, 'quota_sub_unlocks must be an array');
      }
      quotaSubUnlocks = [];
      const seen = new Set<string>();
      for (let i = 0; i < subUnlocksRaw.length; i++) {
        const r = subUnlocksRaw[i] as { dimension_key?: string; per_month_quantity?: number };
        if (typeof r?.dimension_key !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(r.dimension_key)) {
          throw new AppError(400, `quota_sub_unlocks[${i}].dimension_key must be snake_case`);
        }
        if (seen.has(r.dimension_key)) {
          throw new AppError(400, `quota_sub_unlocks: duplicate dimension_key '${r.dimension_key}'`);
        }
        seen.add(r.dimension_key);
        if (typeof r.per_month_quantity !== 'number' || !Number.isInteger(r.per_month_quantity) || r.per_month_quantity < 1) {
          throw new AppError(400, `quota_sub_unlocks[${i}].per_month_quantity must be a positive integer`);
        }
        quotaSubUnlocks.push({
          dimension_key: r.dimension_key,
          per_month_quantity: r.per_month_quantity,
        });
      }
    }

    const patch = {
      name: readString(body, 'name'),
      description: readString(body, 'description'),
      unit_amount_cents: readOptionalNumber(body, 'unit_amount_cents'),
      volume_ladder: volumeLadder,
      first_n_free_quantity: firstNFree,
      quantity_metered_dimension: meteredDim,
      tiers,
      dimensions,
    };
    const billingModeRaw = readString(body, 'billing_mode');

    let plan = await updatePlan(planId, patch, actorId(request));

    if (quotaSubUnlocks !== undefined) {
      // Replace-in-place: delete existing, insert new (transactional).
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM plan_quota_sub_unlocks WHERE plan_id = $1`, [planId]);
        for (const su of quotaSubUnlocks) {
          await client.query(
            `INSERT INTO plan_quota_sub_unlocks (plan_id, dimension_key, per_month_quantity)
             VALUES ($1, $2, $3)`,
            [planId, su.dimension_key, su.per_month_quantity],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    if (billingModeRaw !== undefined) {
      if (!VALID_BILLING_MODES.includes(billingModeRaw as BillingMode)) {
        throw new AppError(
          400,
          `billing_mode must be one of ${VALID_BILLING_MODES.join('|')}`,
        );
      }
      plan = await updatePlanBillingMode(
        planId,
        billingModeRaw as BillingMode,
        actorId(request) ?? '',
      );
    }

    return reply.send(plan);
  });

  // ── DELETE soft-archive ───────────────────────────────────────────────
  fastify.delete('/api/v1/admin/plans/:planId', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    await assertPlanAccess(request, planId);
    try {
      const plan = await softArchivePlan(planId, actorId(request));
      return reply.send(plan);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 422) {
        const guarded = err as SoftArchivePlanError422;
        return reply.status(422).send({
          error: err.message,
          activeSubscribers: guarded.activeSubscribers,
        });
      }
      throw err;
    }
  });
};

export default adminPlansRoutes;
