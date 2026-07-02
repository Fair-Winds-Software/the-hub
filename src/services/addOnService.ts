// Authorized by HUB-1473 — createAddOn(): Stripe Price creation for add-on catalog definitions
// Authorized by HUB-1474 — activateAddOn(): add Stripe subscription item to tenant's existing subscription
// Authorized by HUB-1475 — deactivateAddOn(): staged period-end removal of Stripe subscription item (D-002)
// Authorized by HUB-1476 — listActiveAddOns(), getAddOnById(), listAddOnsByProduct()
// Authorized by HUB-1478 — archiveAddOn(), activateAddOnDefinition(); AUDIT-003 delta_data compliance
// Authorized by HUB-1652 (E-FE-5 S2) — updateAddOn + softArchiveAddOn: partial-patch update
//   with audit_log emission and a soft-archive path guarded by tenant_add_ons.status='active'
//   references. Mirrors the HUB-1651 plans extension for shape + audit contract.
import { getPool } from '../db/pool.js';
import { getStripe, stripeIdempotencyKey, mapStripeError } from '../stripe/client.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { writeAuditEntry } from './auditLogService.js';

export type AddOnBillingType = 'recurring' | 'one_time';
export type AddOnBillingInterval = 'month' | 'quarter' | 'year' | 'one_time';

export interface AddOnDef {
  key: string;
  name: string;
  description?: string;
  billingType: AddOnBillingType;
  billingInterval?: AddOnBillingInterval;
  unitAmountCents: number;
  metadata?: Record<string, unknown>;
}

export interface AddOnRow {
  id: string;
  product_id: string;
  key: string;
  name: string;
  description: string | null;
  billing_type: AddOnBillingType;
  billing_interval: AddOnBillingInterval | null;
  unit_amount_cents: number;
  stripe_price_id: string;
  active: boolean;
  metadata: unknown | null;
  delta_data: unknown | null;
  created_at: Date;
  updated_at: Date;
}

export interface TenantAddOnRow {
  id: string;
  tenant_id: string;
  product_id: string;
  add_on_id: string;
  stripe_subscription_item_id: string | null;
  quantity: number;
  status: 'active' | 'cancelled';
  activated_at: Date;
  cancelled_at: Date | null;
  delta_data: unknown | null;
  created_at: Date;
}

export interface TenantAddOnDetailRow extends TenantAddOnRow {
  name: string;
  billing_type: AddOnBillingType;
  unit_amount_cents: number;
  stripe_price_id: string;
}

const INTERVAL_MAP: Record<string, { interval: 'month' | 'year'; interval_count: number }> = {
  month:   { interval: 'month', interval_count: 1 },
  quarter: { interval: 'month', interval_count: 3 },
  year:    { interval: 'year',  interval_count: 1 },
};

async function withStripeTimeout<T>(fn: () => Promise<T>, ms = 5000): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Stripe API call timed out after 5s')), ms),
  );
  return Promise.race([fn(), timeout]);
}

// Resolves the cached stripe_product_id for a HUB product (created by E10a createPlan flow).
async function resolveStripeProduct(productId: string): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ stripe_product_id: string | null }>(
    'SELECT stripe_product_id FROM products WHERE id = $1',
    [productId],
  );
  if (!rows[0]) throw new AppError(404, 'Product not found');
  if (!rows[0].stripe_product_id) throw new AppError(400, 'Product has no Stripe Product — create a base plan first');
  return rows[0].stripe_product_id;
}

// Creates an add-on catalog definition: Stripe Price + add_ons row.
// Idempotent by (product_id, key): returns existing add-on if found.
export async function createAddOn(productId: string, addOnDef: AddOnDef): Promise<AddOnRow> {
  const pool = getPool();

  const { rows: existing } = await pool.query<AddOnRow>(
    'SELECT * FROM add_ons WHERE product_id = $1 AND key = $2',
    [productId, addOnDef.key],
  );
  if (existing[0]) return existing[0];

  const stripeProductId = await resolveStripeProduct(productId);
  const stripe = getStripe();

  const priceParams =
    addOnDef.billingType === 'one_time'
      ? {
          product: stripeProductId,
          currency: 'usd',
          unit_amount: addOnDef.unitAmountCents,
        }
      : (() => {
          const intervalKey =
            addOnDef.billingInterval && addOnDef.billingInterval !== 'one_time'
              ? addOnDef.billingInterval
              : 'month';
          const intervalParams = INTERVAL_MAP[intervalKey] ?? { interval: 'month' as const, interval_count: 1 };
          return {
            product: stripeProductId,
            currency: 'usd',
            billing_scheme: 'per_unit' as const,
            unit_amount: addOnDef.unitAmountCents,
            recurring: { ...intervalParams, usage_type: 'licensed' as const },
          };
        })();

  let stripePriceId: string;
  try {
    const stripePrice = await withStripeTimeout(() =>
      stripe.prices.create(priceParams, {
        idempotencyKey: stripeIdempotencyKey('create-addon-price', productId, addOnDef.key),
      }),
    );
    stripePriceId = stripePrice.id;
  } catch (err) {
    mapStripeError(err);
    throw err;
  }

  const { rows } = await pool.query<AddOnRow>(
    `INSERT INTO add_ons
       (product_id, key, name, description, billing_type, billing_interval,
        unit_amount_cents, stripe_price_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      productId,
      addOnDef.key,
      addOnDef.name,
      addOnDef.description ?? null,
      addOnDef.billingType,
      addOnDef.billingInterval ?? null,
      addOnDef.unitAmountCents,
      stripePriceId,
      addOnDef.metadata ? JSON.stringify(addOnDef.metadata) : null,
    ],
  );

  return rows[0]!;
}

// Activates an add-on definition (sets active=true). Counter to archiveAddOn.
export async function activateAddOnDefinition(addOnId: string): Promise<AddOnRow> {
  const pool = getPool();
  const { rows } = await pool.query<AddOnRow>(
    'UPDATE add_ons SET active = true WHERE id = $1 RETURNING *',
    [addOnId],
  );
  if (!rows[0]) throw new AppError(404, 'Add-on not found');
  return rows[0];
}

// Soft-archives an add-on: sets active=false. Does NOT call Stripe.
// Existing tenant subscription items on the archived Stripe Price remain valid.
export async function archiveAddOn(addOnId: string): Promise<AddOnRow> {
  const pool = getPool();

  const { rows: current } = await pool.query<AddOnRow>(
    'SELECT * FROM add_ons WHERE id = $1',
    [addOnId],
  );
  if (!current[0]) throw new AppError(404, 'Add-on not found');
  if (!current[0].active) throw new AppError(409, 'Add-on is already archived');

  const { rows } = await pool.query<AddOnRow>(
    'UPDATE add_ons SET active = false WHERE id = $1 RETURNING *',
    [addOnId],
  );
  return rows[0]!;
}

// Activates an add-on for a tenant: adds a Stripe subscription item to the tenant's base subscription.
// Idempotent: returns existing active row if already activated for this (tenant, product, add-on).
export async function activateAddOn(
  tenantId: string,
  productId: string,
  addOnId: string,
  quantity = 1,
): Promise<TenantAddOnRow> {
  const pool = getPool();

  // Verify tenant has an active base subscription
  const { rows: subs } = await pool.query<{ stripe_subscription_id: string }>(
    `SELECT stripe_subscription_id FROM stripe_subscriptions
     WHERE tenant_id = $1 AND product_id = $2
       AND status NOT IN ('canceled', 'unpaid')
     LIMIT 1`,
    [tenantId, productId],
  );
  if (!subs[0]) throw new AppError(400, 'No active subscription');

  const stripeSubscriptionId = subs[0].stripe_subscription_id;

  // Verify add-on is defined and active
  const addOn = await getAddOnById(addOnId);
  if (!addOn.active) throw new AppError(400, 'Add-on is not active');

  // Idempotency: return existing active row
  const { rows: existing } = await pool.query<TenantAddOnRow>(
    `SELECT * FROM tenant_add_ons
     WHERE tenant_id = $1 AND product_id = $2 AND add_on_id = $3 AND status = 'active'`,
    [tenantId, productId, addOnId],
  );
  if (existing[0]) return existing[0];

  const stripe = getStripe();
  let updatedSub: import('stripe').default.Subscription;
  try {
    updatedSub = await withStripeTimeout(() =>
      stripe.subscriptions.update(
        stripeSubscriptionId,
        { items: [{ price: addOn.stripe_price_id, quantity }] },
        { idempotencyKey: stripeIdempotencyKey('activate-addon', tenantId, addOnId) },
      ),
    );
  } catch (err) {
    mapStripeError(err);
    throw err;
  }

  // Find the new subscription item by price ID match (not by array position)
  const newItem = updatedSub.items.data.find(
    (item) => (item.price as { id: string }).id === addOn.stripe_price_id,
  );
  if (!newItem) {
    logger.error({ tenantId, addOnId, stripeSubscriptionId }, 'activateAddOn: Stripe item not found after update');
    throw new AppError(500, 'Failed to locate subscription item after Stripe update');
  }

  const { rows } = await pool.query<TenantAddOnRow>(
    `INSERT INTO tenant_add_ons
       (tenant_id, product_id, add_on_id, stripe_subscription_item_id, quantity, status, activated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NOW())
     RETURNING *`,
    [tenantId, productId, addOnId, newItem.id, quantity],
  );

  return rows[0]!;
}

// Deactivates a tenant's add-on: removes the Stripe subscription item at period end (D-002).
// Throws 409 if already cancelled. No proration (proration_behavior:'none').
export async function deactivateAddOn(
  tenantId: string,
  productId: string,
  addOnId: string,
): Promise<TenantAddOnRow> {
  const pool = getPool();

  const { rows: active } = await pool.query<TenantAddOnRow>(
    `SELECT * FROM tenant_add_ons
     WHERE tenant_id = $1 AND product_id = $2 AND add_on_id = $3`,
    [tenantId, productId, addOnId],
  );
  const row = active[0];
  if (!row) throw new AppError(404, 'No active add-on');
  if (row.status === 'cancelled') throw new AppError(409, 'Add-on already cancelled');

  const { rows: subs } = await pool.query<{ stripe_subscription_id: string }>(
    'SELECT stripe_subscription_id FROM stripe_subscriptions WHERE tenant_id = $1 AND product_id = $2 AND status NOT IN (\'canceled\',\'unpaid\') LIMIT 1',
    [tenantId, productId],
  );

  if (subs[0] && row.stripe_subscription_item_id) {
    const stripe = getStripe();
    try {
      await withStripeTimeout(() =>
        stripe.subscriptions.update(subs[0]!.stripe_subscription_id, {
          items: [{ id: row.stripe_subscription_item_id!, deleted: true }],
          proration_behavior: 'none',
        }),
      );
    } catch (err) {
      mapStripeError(err);
      throw err;
    }
  }

  const { rows: updated } = await pool.query<TenantAddOnRow>(
    `UPDATE tenant_add_ons
     SET status = 'cancelled', cancelled_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [row.id],
  );

  return updated[0]!;
}

// Lists all active add-ons for a tenant-product pair, joined with add-on catalog details.
export async function listActiveAddOns(
  tenantId: string,
  productId: string,
): Promise<TenantAddOnDetailRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<TenantAddOnDetailRow>(
    `SELECT ta.*, a.name, a.billing_type, a.unit_amount_cents, a.stripe_price_id
     FROM tenant_add_ons ta
     JOIN add_ons a ON ta.add_on_id = a.id
     WHERE ta.tenant_id = $1 AND ta.product_id = $2 AND ta.status = 'active'
     ORDER BY ta.activated_at ASC`,
    [tenantId, productId],
  );
  return rows;
}

// Looks up an add-on catalog entry by ID. Used internally and by E10c discount engine.
export async function getAddOnById(addOnId: string): Promise<AddOnRow> {
  const pool = getPool();
  const { rows } = await pool.query<AddOnRow>(
    'SELECT * FROM add_ons WHERE id = $1',
    [addOnId],
  );
  if (!rows[0]) throw new AppError(404, 'Add-on not found');
  return rows[0];
}

// Lists add-ons for a product. Excludes inactive add-ons by default.
export async function listAddOnsByProduct(
  productId: string,
  options: { includeInactive?: boolean } = {},
): Promise<AddOnRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<AddOnRow>(
    `SELECT * FROM add_ons
     WHERE product_id = $1
     ${options.includeInactive ? '' : "AND active = true"}
     ORDER BY created_at ASC`,
    [productId],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// HUB-1652 (E-FE-5 S2) — admin CRUD extensions
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateAddOnPatch {
  name?: string;
  description?: string | null;
  unit_amount_cents?: number;
}

/**
 * HUB-1652 (E-FE-5 S2): partial update of an add-on's mutable fields
 * (name, description, unit_amount_cents). Emits an audit_log entry with
 * before/after values. Throws 404 if the add-on does not exist. Fields
 * not present on the patch object are left untouched. Stripe artifacts
 * are NOT touched — the FE UI cannot rename or reprice the Stripe Price;
 * if operators need to change unit_amount_cents on the Stripe side, they
 * must archive + create a new add-on.
 */
export async function updateAddOn(
  addOnId: string,
  patch: UpdateAddOnPatch,
  actorId: string | null,
): Promise<AddOnRow> {
  const pool = getPool();

  const setFragments: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (patch.name !== undefined) {
    setFragments.push(`name = $${idx++}`);
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    setFragments.push(`description = $${idx++}`);
    params.push(patch.description);
  }
  if (patch.unit_amount_cents !== undefined) {
    setFragments.push(`unit_amount_cents = $${idx++}`);
    params.push(patch.unit_amount_cents);
  }

  const { rows: before } = await pool.query<AddOnRow>(
    'SELECT * FROM add_ons WHERE id = $1',
    [addOnId],
  );
  if (!before[0]) throw new AppError(404, 'Add-on not found');

  if (setFragments.length === 0) return before[0];

  setFragments.push('updated_at = NOW()');
  params.push(addOnId);

  const { rows: updated } = await pool.query<AddOnRow>(
    `UPDATE add_ons SET ${setFragments.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );

  await writeAuditEntry({
    tenant_id: '00000000-0000-0000-0000-0000000000a1',
    product_id: before[0].product_id,
    actor_id: actorId,
    actor_type: 'operator',
    operation: 'UPDATE',
    table_name: 'add_ons',
    record_id: addOnId,
    old_values: {
      name: before[0].name,
      description: before[0].description,
      unit_amount_cents: before[0].unit_amount_cents,
    },
    new_values: {
      name: updated[0]!.name,
      description: updated[0]!.description,
      unit_amount_cents: updated[0]!.unit_amount_cents,
    },
  });

  return updated[0]!;
}

/**
 * HUB-1652 (E-FE-5 S2): soft-archive an add-on with an active-references
 * guard. Checks tenant_add_ons for rows referencing this addOnId with
 * status='active'; if any exist, throws AppError(422) whose message
 * contains the current active count so the route can echo it back to the
 * operator UI. Otherwise sets `active=false` AND `archived_at=NOW()`
 * atomically, writes an audit_log entry, and returns the updated row.
 * Idempotent: re-archiving an already-archived add-on returns the row
 * without a second audit write.
 */
export interface SoftArchiveAddOnError422 extends AppError {
  activeSubscribers: number;
}

export async function softArchiveAddOn(
  addOnId: string,
  actorId: string | null,
): Promise<AddOnRow> {
  const pool = getPool();
  const { rows: before } = await pool.query<AddOnRow & { archived_at: Date | null }>(
    'SELECT * FROM add_ons WHERE id = $1',
    [addOnId],
  );
  if (!before[0]) throw new AppError(404, 'Add-on not found');
  if (before[0].archived_at !== null) return before[0];

  const { rows: refs } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
       FROM tenant_add_ons
      WHERE add_on_id = $1
        AND status = 'active'`,
    [addOnId],
  );
  const activeSubscribers = parseInt(refs[0]!.count, 10);
  if (activeSubscribers > 0) {
    const err = new AppError(
      422,
      `Add-on has ${activeSubscribers} active subscriber(s); archive blocked`,
    ) as SoftArchiveAddOnError422;
    err.activeSubscribers = activeSubscribers;
    throw err;
  }

  const { rows: updated } = await pool.query<AddOnRow>(
    `UPDATE add_ons
        SET active = false,
            archived_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
   RETURNING *`,
    [addOnId],
  );

  await writeAuditEntry({
    tenant_id: '00000000-0000-0000-0000-0000000000a1',
    product_id: before[0].product_id,
    actor_id: actorId,
    actor_type: 'operator',
    operation: 'DELETE',
    table_name: 'add_ons',
    record_id: addOnId,
    old_values: { active: true, archived_at: null },
    new_values: {
      active: false,
      archived_at: updated[0]!.updated_at,
      event: 'addon.soft_archived',
    },
  });

  return updated[0]!;
}
