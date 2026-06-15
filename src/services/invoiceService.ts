// Authorized by HUB-462 — invoice service: getInvoices, handleInvoiceCreated, handleInvoiceFinalized,
//   handleInvoicePaymentSucceeded, handleInvoicePaymentFailed
import type Stripe from 'stripe';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getBillingPaymentFailedQueue, defaultJobOptions } from '../queues/index.js';

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  product_id: string;
  stripe_invoice_id: string;
  stripe_subscription_id: string;
  status: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  period_start: Date;
  period_end: Date;
  invoice_pdf_url: string | null;
  payment_failed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

// Returns invoices for a tenant ordered by period_start DESC, optionally filtered by productId.
export async function getInvoices(
  tenantId: string,
  productId?: string,
  limit?: number,
): Promise<InvoiceRow[]> {
  const pool = getPool();
  const safeLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  if (productId) {
    const { rows } = await pool.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE tenant_id = $1 AND product_id = $2 ORDER BY period_start DESC LIMIT $3',
      [tenantId, productId, safeLimit],
    );
    return rows;
  }

  const { rows } = await pool.query<InvoiceRow>(
    'SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY period_start DESC LIMIT $2',
    [tenantId, safeLimit],
  );
  return rows;
}

// Extracts the subscription ID string from Invoice.parent — handles string | Subscription
function resolveSubscriptionId(parent: Stripe.Invoice['parent']): string | null {
  const sub = parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === 'string' ? sub : sub.id;
}

// Extracts the price ID string from InvoiceLineItem.pricing (v22 type change: no longer .price)
function resolvePriceId(item: Stripe.InvoiceLineItem): string {
  const price = item.pricing?.price_details?.price;
  if (!price) return '';
  return typeof price === 'string' ? price : price.id;
}

// Webhook processor for invoice.created events.
// Resolves product_id via stripe_subscriptions, upserts invoices + invoice_items.
// Throws AppError(404) when the subscription row is absent — triggers BullMQ retry.
export async function handleInvoiceCreated(eventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ raw_event: string }>(
    'SELECT raw_event FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );

  if (!rows[0]) {
    logger.warn({ eventId }, 'handleInvoiceCreated: event not found in DB');
    return;
  }

  const event = JSON.parse(rows[0].raw_event) as Stripe.Event;
  const invoice = event.data.object as Stripe.Invoice;
  const stripeSubscriptionId = resolveSubscriptionId(invoice.parent);

  if (!stripeSubscriptionId) {
    logger.warn({ eventId, invoiceId: invoice.id }, 'handleInvoiceCreated: no subscription on invoice — skipping');
    return;
  }

  const { rows: subRows } = await pool.query<{ tenant_id: string; product_id: string }>(
    'SELECT tenant_id, product_id FROM stripe_subscriptions WHERE stripe_subscription_id = $1',
    [stripeSubscriptionId],
  );

  if (!subRows[0]) {
    // Throw so BullMQ retries — subscription upsert may not have completed yet
    throw new AppError(404, `handleInvoiceCreated: stripe_subscription ${stripeSubscriptionId} not found`);
  }

  const { tenant_id: tenantId, product_id: productId } = subRows[0];

  const { rows: invRows } = await pool.query<{ id: string }>(
    `INSERT INTO invoices
       (tenant_id, product_id, stripe_invoice_id, stripe_subscription_id, status,
        amount_due, amount_paid, currency, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), to_timestamp($10))
     ON CONFLICT (stripe_invoice_id) DO UPDATE
       SET status      = EXCLUDED.status,
           amount_due  = EXCLUDED.amount_due,
           amount_paid = EXCLUDED.amount_paid
     RETURNING id`,
    [
      tenantId,
      productId,
      invoice.id,
      stripeSubscriptionId,
      invoice.status ?? 'draft',
      invoice.amount_due,
      invoice.amount_paid,
      invoice.currency,
      invoice.period_start,
      invoice.period_end,
    ],
  );

  const invoiceDbId = invRows[0]?.id;
  if (!invoiceDbId) return;

  for (const item of invoice.lines.data) {
    await pool.query(
      `INSERT INTO invoice_items
         (invoice_id, stripe_invoice_item_id, description, amount, quantity, stripe_price_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stripe_invoice_item_id) DO NOTHING`,
      [
        invoiceDbId,
        item.id,
        item.description ?? null,
        item.amount,
        item.quantity ?? 1,
        resolvePriceId(item),
      ],
    );
  }

  logger.info({ eventId, invoiceId: invoice.id, tenantId, productId }, 'invoice created');
}

// Webhook processor for invoice.finalized events.
// Updates status to 'open' and records invoice_pdf_url.
export async function handleInvoiceFinalized(eventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ raw_event: string }>(
    'SELECT raw_event FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );

  if (!rows[0]) {
    logger.warn({ eventId }, 'handleInvoiceFinalized: event not found in DB');
    return;
  }

  const event = JSON.parse(rows[0].raw_event) as Stripe.Event;
  const invoice = event.data.object as Stripe.Invoice;

  await pool.query(
    `UPDATE invoices SET status = 'open', invoice_pdf_url = $2 WHERE stripe_invoice_id = $1`,
    [invoice.id, invoice.invoice_pdf ?? null],
  );

  logger.info({ eventId, invoiceId: invoice.id }, 'invoice finalized');
}

// Webhook processor for invoice.payment_succeeded events.
// Updates status to 'paid', records amount_paid, clears payment_failed_at.
export async function handleInvoicePaymentSucceeded(eventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ raw_event: string }>(
    'SELECT raw_event FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );

  if (!rows[0]) {
    logger.warn({ eventId }, 'handleInvoicePaymentSucceeded: event not found in DB');
    return;
  }

  const event = JSON.parse(rows[0].raw_event) as Stripe.Event;
  const invoice = event.data.object as Stripe.Invoice;

  await pool.query(
    `UPDATE invoices SET status = 'paid', amount_paid = $2, payment_failed_at = NULL WHERE stripe_invoice_id = $1`,
    [invoice.id, invoice.amount_paid],
  );

  logger.info({ eventId, invoiceId: invoice.id }, 'invoice payment succeeded');
}

// Webhook processor for invoice.payment_failed events.
// Records payment failure and enqueues billing-payment-failed job with dedup key.
export async function handleInvoicePaymentFailed(eventId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ raw_event: string }>(
    'SELECT raw_event FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );

  if (!rows[0]) {
    logger.warn({ eventId }, 'handleInvoicePaymentFailed: event not found in DB');
    return;
  }

  const event = JSON.parse(rows[0].raw_event) as Stripe.Event;
  const invoice = event.data.object as Stripe.Invoice;

  await pool.query(
    `UPDATE invoices SET status = 'payment_failed', payment_failed_at = NOW() WHERE stripe_invoice_id = $1`,
    [invoice.id],
  );

  const queue = getBillingPaymentFailedQueue();
  await queue.add(
    'billing_payment_failed',
    { stripe_invoice_id: invoice.id, event_id: eventId },
    {
      ...defaultJobOptions({ maxAttempts: 5, backoff: { type: 'exponential', delay: 500 } }),
      jobId: `billing_payment_failed:${invoice.id}`,
    },
  );

  logger.info({ eventId, invoiceId: invoice.id }, 'invoice payment failed — billing job enqueued');
}
