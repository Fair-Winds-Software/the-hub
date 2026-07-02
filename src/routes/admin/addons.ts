// Authorized by HUB-1652 (E-FE-5 S2) — admin add-ons CRUD.
//
// Wires the existing addOnService.ts primitives + the new updateAddOn /
// softArchiveAddOn extensions from HUB-1652 into 4 REST endpoints consumed
// by the HUB-1656 add-on management UI. Mirrors HUB-1651's plans route
// shape 1:1 so the FE hook patterns stay symmetrical.
//
// Endpoints (all sit inside adminRoutesPlugin's RBAC scope):
//   GET    /api/v1/admin/addons?productId=<uuid>&includeArchived=false
//   POST   /api/v1/admin/addons             { productId, key, name, billing_type, billing_interval, unit_amount_cents, description? }
//   PUT    /api/v1/admin/addons/:addonId    { name?, description?, unit_amount_cents? }
//   DELETE /api/v1/admin/addons/:addonId    → soft archive (422 if active tenant references)
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Migration filename: spec named 051_add_ons_archived_at.sql. 051..055
//      are already taken; 056 is HUB-1651's plans_archived_at. Next
//      available slot is 057 — same renumber pattern used by HUB-1651.
//
//   2. Soft-archive semantics: mirrors HUB-1651's plans design — both
//      active=false AND archived_at=NOW() are set atomically inside the
//      softArchiveAddOn service extension; reads via this route's GET
//      filter on archived_at IS NULL when includeArchived=false.
//
//   3. Active-references guard uses tenant_add_ons.status='active' (not
//      stripe_subscriptions.plan_id like S1). Same 422 shape:
//      { error, activeSubscribers: N }.
//
//   4. Audit surface: every mutation writes an audit_log entry via
//      writeAuditEntry (operation INSERT|UPDATE|DELETE, table_name='add_ons',
//      record_id=addonId, actor_id=<operator JWT operator_id>).
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import {
  createAddOn,
  listAddOnsByProduct,
  getAddOnById,
  updateAddOn,
  softArchiveAddOn,
  type AddOnBillingType,
  type AddOnBillingInterval,
  type SoftArchiveAddOnError422,
} from '../../services/addOnService.js';
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

async function assertAddOnAccess(
  request: FastifyRequest,
  addOnId: string,
): Promise<{ tenantId: string; productId: string }> {
  assertUUID(addOnId, 'addonId');
  const op = request.operatorUser!;
  const { rows } = await getPool().query<{ product_id: string; tenant_id: string }>(
    `SELECT a.product_id AS product_id, pr.tenant_id AS tenant_id
       FROM add_ons a
       JOIN products pr ON pr.id = a.product_id
      WHERE a.id = $1`,
    [addOnId],
  );
  if (!rows[0]) throw new AppError(404, 'Add-on not found');
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

const VALID_BILLING_TYPES: AddOnBillingType[] = ['recurring', 'one_time'];
const VALID_BILLING_INTERVALS: AddOnBillingInterval[] = [
  'month',
  'quarter',
  'year',
  'one_time',
];

const adminAddOnsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET list ──────────────────────────────────────────────────────────
  fastify.get('/api/v1/admin/addons', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const productId = q.productId ?? '';
    await assertProductAccess(request, productId);
    const includeArchived = q.includeArchived === 'true';
    const addons = await listAddOnsByProduct(productId, {
      includeInactive: includeArchived,
    });
    return reply.send({ data: addons, total: addons.length });
  });

  // ── POST create ───────────────────────────────────────────────────────
  fastify.post('/api/v1/admin/addons', async (request, reply) => {
    const body = (request.body as Record<string, unknown> | null) ?? {};
    const productId = readString(body, 'productId') ?? '';
    await assertProductAccess(request, productId);

    const key = readString(body, 'key');
    const name = readString(body, 'name');
    const description = readString(body, 'description');
    const billingTypeRaw = readString(body, 'billing_type');
    const billingIntervalRaw = readString(body, 'billing_interval');
    const unitAmountCents = readOptionalNumber(body, 'unit_amount_cents');

    if (!key) throw new AppError(400, 'key is required');
    if (!name) throw new AppError(400, 'name is required');
    if (
      !billingTypeRaw ||
      !VALID_BILLING_TYPES.includes(billingTypeRaw as AddOnBillingType)
    ) {
      throw new AppError(
        400,
        `billing_type must be one of ${VALID_BILLING_TYPES.join('|')}`,
      );
    }
    if (
      billingIntervalRaw !== undefined &&
      !VALID_BILLING_INTERVALS.includes(billingIntervalRaw as AddOnBillingInterval)
    ) {
      throw new AppError(
        400,
        `billing_interval must be one of ${VALID_BILLING_INTERVALS.join('|')}`,
      );
    }
    if (unitAmountCents === undefined) {
      throw new AppError(400, 'unit_amount_cents is required');
    }

    const addon = await createAddOn(productId, {
      key,
      name,
      description,
      billingType: billingTypeRaw as AddOnBillingType,
      billingInterval: (billingIntervalRaw as AddOnBillingInterval) ?? undefined,
      unitAmountCents,
    });

    await writeAuditEntry({
      tenant_id: '00000000-0000-0000-0000-0000000000a1',
      product_id: productId,
      actor_id: actorId(request),
      actor_type: 'operator',
      operation: 'INSERT',
      table_name: 'add_ons',
      record_id: addon.id,
      old_values: null,
      new_values: {
        key: addon.key,
        name: addon.name,
        billing_type: addon.billing_type,
        billing_interval: addon.billing_interval,
        unit_amount_cents: addon.unit_amount_cents,
      },
    });

    const fresh = await getAddOnById(addon.id);
    return reply.status(201).send(fresh);
  });

  // ── PUT update ────────────────────────────────────────────────────────
  fastify.put('/api/v1/admin/addons/:addonId', async (request, reply) => {
    const { addonId } = request.params as { addonId: string };
    await assertAddOnAccess(request, addonId);
    const body = (request.body as Record<string, unknown> | null) ?? {};

    const patch = {
      name: readString(body, 'name'),
      description: readString(body, 'description'),
      unit_amount_cents: readOptionalNumber(body, 'unit_amount_cents'),
    };

    const addon = await updateAddOn(addonId, patch, actorId(request));
    return reply.send(addon);
  });

  // ── DELETE soft-archive ───────────────────────────────────────────────
  fastify.delete('/api/v1/admin/addons/:addonId', async (request, reply) => {
    const { addonId } = request.params as { addonId: string };
    await assertAddOnAccess(request, addonId);
    try {
      const addon = await softArchiveAddOn(addonId, actorId(request));
      return reply.send(addon);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 422) {
        const guarded = err as SoftArchiveAddOnError422;
        return reply.status(422).send({
          error: err.message,
          activeSubscribers: guarded.activeSubscribers,
        });
      }
      throw err;
    }
  });
};

export default adminAddOnsRoutes;
