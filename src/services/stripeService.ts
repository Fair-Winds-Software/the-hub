// Authorized by HUB-426 — ensureStripeCustomer: get-or-create Stripe customer, upsert stripe_customers
// Authorized by HUB-427 — createSubscription, cancelSubscription, getSubscription
// Authorized by HUB-428 — handleSubscriptionUpdated, handleSubscriptionDeleted webhook processors
// Authorized by HUB-1491 — handleSubscriptionUpdated enqueues confirm-plan-change BullMQ job
// Authorized by HUB-1470 — BILL-004 wire-up: createSubscription accepts planId; resolves stripe_price_id internally
import type Stripe from 'stripe';
import { getPool } from '../db/pool.js';
import { getStripe, stripeIdempotencyKey, mapStripeError } from '../stripe/client.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getPlanById } from './planCatalogService.js';

export interface StripeSubscriptionRow {
  id: string;
  tenant_id: string;
  product_id: string;
  plan_id: string | null;
  stripe_subscription_id: string;
  stripe_price_id: string;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// Gets or creates a Stripe customer for the tenant. Returns the stripe_customer_id.
// Idempotent: if stripe_customers row already exists, returns without calling Stripe.
export async function ensureStripeCustomer(tenantId: string, email: string): Promise<string> {
  const pool = getPool();

  const { rows } = await pool.query<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM stripe_customers WHERE tenant_id = $1',
    [tenantId],
  );

  if (rows[0]) return rows[0].stripe_customer_id;

  const stripe = getStripe();
  let customer: Stripe.Customer;
  try {
    customer = await stripe.customers.create(
      { email, metadata: { tenant_id: tenantId } },
      { idempotencyKey: stripeIdempotencyKey('create-customer', tenantId) },
    );
  } catch (err) {
    mapStripeError(err);
  }

  const { rows: upserted } = await pool.query<{ stripe_customer_id: string }>(
    `INSERT INTO stripe_customers (tenant_id, stripe_customer_id)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id
     RETURNING stripe_customer_id`,
    [tenantId, customer!.id],
  );

  return upserted[0].stripe_customer_id;
}

// Creates a Stripe subscription for the given tenant + product, persists to stripe_subscriptions.
// Accepts planId (BILL-004): resolves stripe_price_id internally via plans table.
// Idempotent via Stripe idempotency key derived from tenantId + productId + planId.
export async function createSubscription(
  tenantId: string,
  productId: string,
  planId: string,
  email: string,
): Promise<StripeSubscriptionRow> {
  const plan = await getPlanById(planId);
  if (!plan.active) throw new AppError(400, 'Plan is archived');
  const priceId = plan.stripe_price_id;

  const customerId = await ensureStripeCustomer(tenantId, email);
  const stripe = getStripe();

  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: priceId }],
        metadata: { tenant_id: tenantId, product_id: productId },
      },
      { idempotencyKey: stripeIdempotencyKey('create-sub', tenantId, productId, planId) },
    );
  } catch (err) {
    mapStripeError(err);
  }

  const item = sub!.items.data[0];
  const pool = getPool();
  const { rows } = await pool.query<StripeSubscriptionRow>(
    `INSERT INTO stripe_subscriptions
       (tenant_id, product_id, plan_id, stripe_subscription_id, stripe_price_id, status,
        current_period_start, current_period_end, cancel_at_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8), $9)
     ON CONFLICT (tenant_id, product_id) DO UPDATE
       SET plan_id                = EXCLUDED.plan_id,
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           stripe_price_id        = EXCLUDED.stripe_price_id,
           status                 = EXCLUDED.status,
           current_period_start   = EXCLUDED.current_period_start,
           current_period_end     = EXCLUDED.current_period_end,
           cancel_at_period_end   = EXCLUDED.cancel_at_period_end
     RETURNING *`,
    [
      tenantId,
      productId,
      planId,
      sub!.id,
      item?.price.id ?? priceId,
      sub!.status,
      item?.current_period_start ?? 0,
      item?.current_period_end ?? 0,
      sub!.cancel_at_period_end,
    ],
  );

  return rows[0];
}

// Cancels a subscription. immediate=false (default) schedules at period end;
// immediate=true cancels now. Throws AppError(404) if no subscription found.
export async function cancelSubscription(
  tenantId: string,
  productId: string,
  immediate: boolean = false,
): Promise<StripeSubscriptionRow> {
  const pool = getPool();
  const { rows } = await pool.query<{ stripe_subscription_id: string }>(
    'SELECT stripe_subscription_id FROM stripe_subscriptions WHERE tenant_id = $1 AND product_id = $2',
    [tenantId, productId],
  );

  if (!rows[0]) {
    throw new AppError(404, 'Subscription not found');
  }

  const stripe = getStripe();
  if (immediate) {
    try {
      await stripe.subscriptions.cancel(rows[0].stripe_subscription_id);
    } catch (err) {
      mapStripeError(err);
    }

    const { rows: updated } = await pool.query<StripeSubscriptionRow>(
      `UPDATE stripe_subscriptions
       SET status = 'canceled', cancelled_at = NOW()
       WHERE tenant_id = $1 AND product_id = $2
       RETURNING *`,
      [tenantId, productId],
    );

    return updated[0];
  }

  try {
    await stripe.subscriptions.update(rows[0].stripe_subscription_id, {
      cancel_at_period_end: true,
    });
  } catch (err) {
    mapStripeError(err);
  }

  const { rows: updated } = await pool.query<StripeSubscriptionRow>(
    `UPDATE stripe_subscriptions
     SET cancel_at_period_end = true
     WHERE tenant_id = $1 AND product_id = $2
     RETURNING *`,
    [tenantId, productId],
  );

  return updated[0];
}

// Returns all subscriptions for a tenant, ordered newest first.
export async function getSubscriptions(tenantId: string): Promise<StripeSubscriptionRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<StripeSubscriptionRow>(
    'SELECT * FROM stripe_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId],
  );
  return rows;
}

// Webhook processor for customer.subscription.updated events.
// Fetches the raw Stripe event from the DB, then upserts stripe_subscriptions.
export async function handleSubscriptionUpdated(eventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ raw_event: string }>(
    'SELECT raw_event FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );

  if (!rows[0]) {
    logger.warn({ eventId }, 'handleSubscriptionUpdated: event not found in DB');
    return;
  }

  const event = JSON.parse(rows[0].raw_event) as Stripe.Event;
  const sub = event.data.object as Stripe.Subscription;
  const productId = sub.metadata?.product_id;
  const tenantId = sub.metadata?.tenant_id;

  if (!productId || !tenantId) {
    logger.warn({ eventId, subId: sub.id }, 'handleSubscriptionUpdated: missing metadata — skipping upsert');
    return;
  }

  const item = sub.items.data[0];
  await pool.query(
    `INSERT INTO stripe_subscriptions
       (tenant_id, product_id, stripe_subscription_id, stripe_price_id, status,
        current_period_start, current_period_end, cancel_at_period_end, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8, $9)
     ON CONFLICT (tenant_id, product_id) DO UPDATE
       SET stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           stripe_price_id        = EXCLUDED.stripe_price_id,
           status                 = EXCLUDED.status,
           current_period_start   = EXCLUDED.current_period_start,
           current_period_end     = EXCLUDED.current_period_end,
           cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
           cancelled_at           = EXCLUDED.cancelled_at`,
    [
      tenantId,
      productId,
      sub.id,
      item?.price.id ?? '',
      sub.status,
      item?.current_period_start ?? 0,
      item?.current_period_end ?? 0,
      sub.cancel_at_period_end,
      sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    ],
  );

  logger.info({ eventId, subId: sub.id, tenantId, productId }, 'subscription updated');

  // Enqueue plan-change confirmation (no-op if no pending ledger entry)
  if (tenantId && productId) {
    const { getBillingJobsQueue } = await import('../queues/index.js');
    await getBillingJobsQueue().add('confirm-plan-change', {
      tenantId,
      productId,
      newStripePriceId: item?.price.id ?? '',
    });
  }
}

// Webhook processor for customer.subscription.deleted events.
// Marks the subscription as canceled in stripe_subscriptions.
export async function handleSubscriptionDeleted(eventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ raw_event: string }>(
    'SELECT raw_event FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );

  if (!rows[0]) {
    logger.warn({ eventId }, 'handleSubscriptionDeleted: event not found in DB');
    return;
  }

  const event = JSON.parse(rows[0].raw_event) as Stripe.Event;
  const sub = event.data.object as Stripe.Subscription;

  await pool.query(
    `UPDATE stripe_subscriptions
     SET status = 'canceled', cancelled_at = NOW()
     WHERE stripe_subscription_id = $1`,
    [sub.id],
  );

  logger.info({ eventId, subId: sub.id }, 'subscription deleted');
}
