// Authorized by HUB-462 — invoice service: getInvoices, handleInvoiceCreated, handleInvoiceFinalized,
//   handleInvoicePaymentSucceeded, handleInvoicePaymentFailed
// Authorized by HUB-1590 (E-BE-1 S7, CR-2) — external_provider column ('stripe' | 'internal');
//   createInternalInvoice() for credit-mode tenants. This service has no runtime Stripe SDK
//   imports (it processes Stripe webhooks; the SDK boundary is src/stripe/client.ts per HUB-1589).
import type Stripe from 'stripe';
import crypto from 'crypto';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getBillingPaymentFailedQueue, defaultJobOptions } from '../queues/index.js';
import { isCreditMode } from './stripeService.js';
import { writeAuditEntry } from './auditLogService.js';

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
  external_provider: 'stripe' | 'internal';
  created_at: Date;
  updated_at: Date;
}

// HUB-1590: synthetic stripe_invoice_id prefix for credit-mode invoices. Downstream
// reconciliation MUST NOT look these up in Stripe; the external_provider column is the
// authoritative discriminator, this prefix is a structural safety net.
const INTERNAL_INVOICE_ID_PREFIX = 'inv_internal:';

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

  const COLS = `id, tenant_id, product_id, stripe_invoice_id, stripe_subscription_id, status,
    amount_due, amount_paid, currency, period_start, period_end, invoice_pdf_url, payment_failed_at,
    external_provider, created_at, updated_at`;

  if (productId) {
    const { rows } = await pool.query<InvoiceRow>(
      `SELECT ${COLS} FROM invoices WHERE tenant_id = $1 AND product_id = $2 ORDER BY period_start DESC LIMIT $3`,
      [tenantId, productId, safeLimit],
    );
    return rows;
  }

  const { rows } = await pool.query<InvoiceRow>(
    `SELECT ${COLS} FROM invoices WHERE tenant_id = $1 ORDER BY period_start DESC LIMIT $2`,
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
        amount_due, amount_paid, currency, period_start, period_end, external_provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), to_timestamp($10), 'stripe')
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

  if (invoice.lines.data.length > 0) {
    const values: unknown[] = [];
    const placeholders = invoice.lines.data.map((item, i) => {
      const base = i * 6;
      values.push(invoiceDbId, item.id, item.description ?? null, item.amount, item.quantity ?? 1, resolvePriceId(item));
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    await pool.query(
      `INSERT INTO invoice_items
         (invoice_id, stripe_invoice_item_id, description, amount, quantity, stripe_price_id)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (stripe_invoice_item_id) DO NOTHING`,
      values,
    );
  }

  logger.info({ eventId, invoiceId: invoice.id, tenantId, productId }, 'invoice created');
}

/**
 * HUB-1590 (CR-2): create an internal invoice row for a credit-mode subscription. Skips the
 * Stripe SDK entirely (this service has no runtime Stripe imports). Writes one audit_log
 * entry tagged with `event_type='invoice.created.internal'` is NOT used (that enum is
 * reserved for auth events per HUB-1704); instead the audit row uses `operation='INSERT'`,
 * `table_name='invoices'`, and `new_values.event='invoice.created.internal'` for the marker.
 *
 * Defensive: throws 400 if the plan is not credit-mode. This entry point is for the
 * credit-mode billing flow only; standard-mode invoices arrive via Stripe webhooks
 * (handleInvoiceCreated).
 */
export async function createInternalInvoice(params: {
  tenantId: string;
  productId: string;
  planId: string;
  stripeSubscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  amountCents: number;
  currency: string;
}): Promise<InvoiceRow> {
  const credit = await isCreditMode(params.planId);
  if (!credit) {
    throw new AppError(400, 'createInternalInvoice requires a credit-mode plan');
  }

  const syntheticInvoiceId = `${INTERNAL_INVOICE_ID_PREFIX}${crypto.randomUUID()}`;
  const pool = getPool();

  const { rows } = await pool.query<InvoiceRow>(
    `INSERT INTO invoices
       (tenant_id, product_id, stripe_invoice_id, stripe_subscription_id, status,
        amount_due, amount_paid, currency, period_start, period_end, external_provider)
     VALUES ($1, $2, $3, $4, 'paid', $5, $5, $6, $7, $8, 'internal')
     RETURNING id, tenant_id, product_id, stripe_invoice_id, stripe_subscription_id, status,
       amount_due, amount_paid, currency, period_start, period_end, invoice_pdf_url,
       payment_failed_at, external_provider, created_at, updated_at`,
    [
      params.tenantId,
      params.productId,
      syntheticInvoiceId,
      params.stripeSubscriptionId,
      params.amountCents,
      params.currency,
      params.periodStart,
      params.periodEnd,
    ],
  );

  const row = rows[0]!;

  await writeAuditEntry({
    tenant_id: params.tenantId,
    product_id: params.productId,
    actor_id: null,
    actor_type: 'system',
    operation: 'INSERT',
    table_name: 'invoices',
    record_id: row.id,
    new_values: {
      event: 'invoice.created.internal',
      stripe_invoice_id: syntheticInvoiceId,
      stripe_subscription_id: params.stripeSubscriptionId,
      amount_due: params.amountCents,
      currency: params.currency,
      external_provider: 'internal',
    },
  });

  logger.info(
    {
      tenantId: params.tenantId,
      productId: params.productId,
      stripeInvoiceId: syntheticInvoiceId,
      event: 'invoice.created.internal',
    },
    'CR-2 internal invoice created — Stripe SDK bypassed',
  );

  return row;
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
