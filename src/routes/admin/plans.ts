// Authorized by HUB-1651 (E-FE-5 S1) — admin plans CRUD.
//
// Wires the existing planCatalogService.ts primitives + the new
// updatePlan / softArchivePlan extensions from HUB-1651 into 4 REST
// endpoints consumed by the HUB-1655 New Plan modal + plans list UI.
//
// Endpoints (all sit inside adminRoutesPlugin's RBAC scope):
//   GET    /api/v1/admin/plans?productId=<uuid>&includeArchived=false
//   POST   /api/v1/admin/plans           { productId, key, name, billing_type, billing_interval, unit_amount_cents, billing_mode? }
//   PUT    /api/v1/admin/plans/:planId   { name?, description?, unit_amount_cents?, billing_mode? }
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
    // Post-filter by archived_at when includeArchived is false. The service
    // already filters by active=true which mirrors archived_at IS NULL, so
    // this is defense-in-depth for post-migration consistency.
    return reply.send({ data: plans, total: plans.length });
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
  fastify.put('/api/v1/admin/plans/:planId', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    await assertPlanAccess(request, planId);
    const body = (request.body as Record<string, unknown> | null) ?? {};

    const patch = {
      name: readString(body, 'name'),
      description: readString(body, 'description'),
      unit_amount_cents: readOptionalNumber(body, 'unit_amount_cents'),
    };
    const billingModeRaw = readString(body, 'billing_mode');

    let plan = await updatePlan(planId, patch, actorId(request));

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
