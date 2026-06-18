// Authorized by HUB-1480 — createDiscount(): named discount catalog backed by Stripe coupons
// Authorized by HUB-1481 — applyDiscount() + removeDiscount(): per-tenant discount operations
import { getPool } from '../db/pool.js';
import { getStripe, stripeIdempotencyKey, mapStripeError } from '../stripe/client.js';
import { AppError } from '../errors/AppError.js';

export interface DiscountDef {
  name: string;
  discount_type: 'percent' | 'amount';
  percent_off?: number;
  amount_off_cents?: number;
  currency?: string;
  duration: 'once' | 'repeating' | 'forever';
  duration_in_months?: number;
  created_by?: string;
  metadata?: Record<string, unknown>;
}

export interface DiscountRow {
  id: string;
  product_id: string;
  name: string;
  discount_type: 'percent' | 'amount';
  value: number;
  currency: string;
  duration: 'once' | 'repeating' | 'forever';
  duration_in_months: number | null;
  stripe_coupon_id: string | null;
  active: boolean;
  created_by: string | null;
  delta_data: unknown | null;
  created_at: Date;
  updated_at: Date;
}

export interface TenantDiscountRow {
  id: string;
  tenant_id: string;
  product_id: string;
  discount_id: string;
  stripe_discount_id: string | null;
  applied_at: Date;
  removed_at: Date | null;
  applied_by: string | null;
  delta_data: unknown | null;
  created_at: Date;
}

async function withStripeTimeout<T>(fn: () => Promise<T>, ms = 5000): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Stripe API call timed out after 5s')), ms),
  );
  return Promise.race([fn(), timeout]);
}

// Creates a named discount backed by a Stripe coupon.
// Idempotent by (product_id, name): throws 409 if name already exists for product.
export async function createDiscount(productId: string, def: DiscountDef): Promise<DiscountRow> {
  const pool = getPool();

  // Idempotency / conflict check
  const { rows: existing } = await pool.query<DiscountRow>(
    'SELECT * FROM discounts WHERE product_id = $1 AND name = $2',
    [productId, def.name],
  );
  if (existing[0]) throw new AppError(409, 'Discount name already exists for product');

  if (def.discount_type === 'percent') {
    const pct = def.percent_off ?? 0;
    if (pct < 1 || pct > 100) throw new AppError(400, 'percent_off must be 1–100');
  }

  const stripe = getStripe();
  const couponParams: Record<string, unknown> = {
    name: def.name,
    duration: def.duration,
    metadata: { hub_product_id: productId, ...(def.metadata ?? {}) },
  };
  if (def.duration === 'repeating') couponParams['duration_in_months'] = def.duration_in_months;
  if (def.discount_type === 'percent') {
    couponParams['percent_off'] = def.percent_off;
  } else {
    couponParams['amount_off'] = def.amount_off_cents;
    couponParams['currency'] = def.currency ?? 'usd';
  }

  let stripeCouponId: string;
  try {
    const coupon = await withStripeTimeout(() =>
      stripe.coupons.create(couponParams as Parameters<typeof stripe.coupons.create>[0], {
        idempotencyKey: stripeIdempotencyKey('create-discount', productId, def.name),
      }),
    );
    stripeCouponId = coupon.id;
  } catch (err) {
    mapStripeError(err);
    throw err;
  }

  const value =
    def.discount_type === 'percent' ? (def.percent_off ?? 0) : (def.amount_off_cents ?? 0);

  const { rows } = await pool.query<DiscountRow>(
    `INSERT INTO discounts
       (product_id, name, discount_type, value, currency, duration, duration_in_months,
        stripe_coupon_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      productId,
      def.name,
      def.discount_type,
      value,
      def.currency ?? 'usd',
      def.duration,
      def.duration_in_months ?? null,
      stripeCouponId,
      def.created_by ?? null,
    ],
  );
  return rows[0]!;
}

// Lists all discounts for a product.
export async function listDiscounts(productId: string): Promise<DiscountRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<DiscountRow>(
    'SELECT * FROM discounts WHERE product_id = $1 ORDER BY created_at DESC',
    [productId],
  );
  return rows;
}

// Applies a discount coupon to a tenant's Stripe customer account.
// Stripe allows only one active coupon per customer — 409 if one already exists.
export async function applyDiscount(
  tenantId: string,
  productId: string,
  discountId: string,
): Promise<TenantDiscountRow> {
  const pool = getPool();

  const { rows: discountRows } = await pool.query<DiscountRow>(
    'SELECT * FROM discounts WHERE id = $1',
    [discountId],
  );
  if (!discountRows[0]) throw new AppError(404, 'Discount not found');
  const discount = discountRows[0];
  if (!discount.active) throw new AppError(409, 'Discount is not active');

  const { rows: subRows } = await pool.query<{ id: string }>(
    `SELECT id FROM stripe_subscriptions
     WHERE tenant_id = $1 AND product_id = $2 AND status NOT IN ('canceled', 'unpaid')
     LIMIT 1`,
    [tenantId, productId],
  );
  if (!subRows[0]) throw new AppError(400, 'Tenant has no active subscription for this product');

  const { rows: activeDiscount } = await pool.query<{ id: string }>(
    `SELECT id FROM tenant_discounts
     WHERE tenant_id = $1 AND product_id = $2 AND removed_at IS NULL
     LIMIT 1`,
    [tenantId, productId],
  );
  if (activeDiscount[0]) throw new AppError(409, 'Tenant already has an active discount for this product');

  const { rows: custRows } = await pool.query<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM stripe_customers WHERE tenant_id = $1',
    [tenantId],
  );
  if (!custRows[0]) throw new AppError(400, 'No Stripe customer for tenant');
  const customerId = custRows[0].stripe_customer_id;

  const stripe = getStripe();
  try {
    // Stripe SDK typings omit `coupon` from CustomerUpdateParams in some versions;
    // the REST API accepts it and the double-cast bypasses excess property checking.
    const couponParams = { coupon: discount.stripe_coupon_id! } as unknown as Parameters<typeof stripe.customers.update>[1];
    await withStripeTimeout(() => stripe.customers.update(customerId, couponParams));
  } catch (err) {
    mapStripeError(err);
    throw err;
  }

  const { rows } = await pool.query<TenantDiscountRow>(
    `INSERT INTO tenant_discounts
       (tenant_id, product_id, discount_id, applied_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING *`,
    [tenantId, productId, discountId],
  );
  return rows[0]!;
}

// Removes the active discount from a tenant's Stripe customer account.
export async function removeDiscount(
  tenantId: string,
  productId: string,
  discountId: string,
): Promise<TenantDiscountRow> {
  const pool = getPool();

  const { rows: activeRows } = await pool.query<TenantDiscountRow>(
    `SELECT * FROM tenant_discounts
     WHERE tenant_id = $1 AND product_id = $2 AND discount_id = $3 AND removed_at IS NULL
     LIMIT 1`,
    [tenantId, productId, discountId],
  );
  if (!activeRows[0]) throw new AppError(404, 'Active discount not found for tenant');

  const { rows: custRows } = await pool.query<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM stripe_customers WHERE tenant_id = $1',
    [tenantId],
  );
  if (!custRows[0]) throw new AppError(400, 'No Stripe customer for tenant');
  const customerId = custRows[0].stripe_customer_id;

  const stripe = getStripe();
  try {
    await withStripeTimeout(() => stripe.customers.deleteDiscount(customerId));
  } catch (err) {
    mapStripeError(err);
    throw err;
  }

  const { rows } = await pool.query<TenantDiscountRow>(
    'UPDATE tenant_discounts SET removed_at = NOW() WHERE id = $1 RETURNING *',
    [activeRows[0].id],
  );
  return rows[0]!;
}
