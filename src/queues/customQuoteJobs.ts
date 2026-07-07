// Authorized by HUB-1735 + HUB-1736 (E-V2-PP-2 S6/S7, HUB-1726, HUB-1701) —
// Two operator-quote jobs. Both are pure async functions suitable for wiring into
// BullMQ workers (the actual queue registration in `src/queues/cron.ts` and
// `src/queues/index.ts` is a follow-up; these are the runnable primitives).
//
//   runQuoteToInvoicePipeline(quoteId)   — S6: attach approved quote line items to
//                                          an internal invoice. Idempotent.
//   runQuoteExpirationSweep()            — S7: transition draft/pending quotes past
//                                          expires_at to 'expired'. Idempotent.

import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

// ─── S6 — invoice pipeline ────────────────────────────────────────────────

export interface QuoteToInvoiceResult {
  quote_id: string;
  invoice_id: string;
  line_items_attached: number;
  /** true if this call actually attached items; false if idempotent no-op. */
  attached: boolean;
}

/**
 * Attach an approved quote's line items to an internal invoice for the tenant+product.
 * Idempotent: if custom_quotes.invoice_id is already set, returns without re-attaching.
 *
 * Invoice creation strategy (HUB-1546 §6 BR-5 credit-mode invariant):
 *   - Always creates an `invoices` row with external_provider='internal' and
 *     stripe_invoice_id/stripe_subscription_id = synthetic values scoped to the quote.
 *   - This holds whether the tenant's plan is billing_mode='standard' or 'credit'; the
 *     custom-quote pipeline never touches Stripe (per D-HUB-QUOTE-EXPIRY-001 style
 *     bound decision — custom quotes are a HUB-internal line-item pipeline, and the
 *     downstream billing sync layer decides whether to push to Stripe based on the
 *     invoice's external_provider).
 */
export async function runQuoteToInvoicePipeline(quoteId: string): Promise<QuoteToInvoiceResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: qRows } = await client.query<{
      id: string;
      tenant_id: string;
      product_id: string;
      status: string;
      total_cents: number;
      currency: string;
      invoice_id: string | null;
    }>(
      `SELECT id, tenant_id, product_id, status, total_cents, currency, invoice_id
         FROM custom_quotes WHERE id = $1 FOR UPDATE`,
      [quoteId],
    );
    const quote = qRows[0];
    if (!quote) {
      await client.query('ROLLBACK');
      throw new AppError(404, `quote ${quoteId} not found`);
    }
    if (quote.status !== 'approved') {
      await client.query('ROLLBACK');
      throw new AppError(400, `quote ${quoteId} status is ${quote.status}; must be approved`);
    }
    if (quote.invoice_id !== null) {
      // Idempotent no-op — the invoice was already attached in a prior run.
      await client.query('COMMIT');
      return {
        quote_id: quote.id,
        invoice_id: quote.invoice_id,
        line_items_attached: 0,
        attached: false,
      };
    }

    // Create an internal invoice for this tenant+product.
    const now = new Date();
    const periodStart = now.toISOString();
    const periodEnd = new Date(now.getTime() + 30 * 86400 * 1000).toISOString();
    const syntheticInvoiceId = `custom_quote:${quote.id}`;

    const { rows: invRows } = await client.query<{ id: string }>(
      `INSERT INTO invoices
         (tenant_id, product_id, stripe_invoice_id, stripe_subscription_id, status,
          amount_due, amount_paid, currency, period_start, period_end, external_provider)
       VALUES ($1, $2, $3, $4, 'open', $5, 0, $6, $7, $8, 'internal')
       RETURNING id`,
      [
        quote.tenant_id,
        quote.product_id,
        syntheticInvoiceId,
        `custom_quote_sub:${quote.id}`,
        quote.total_cents,
        quote.currency,
        periodStart,
        periodEnd,
      ],
    );
    const invoiceId = invRows[0]!.id;

    // Read all line items for the quote and copy them to invoice_items.
    const { rows: liRows } = await client.query<{
      id: string;
      description: string;
      quantity: number;
      unit_amount_cents: number;
    }>(
      `SELECT id, description, quantity, unit_amount_cents
         FROM custom_quote_line_items WHERE quote_id = $1 ORDER BY sort_order ASC`,
      [quote.id],
    );

    for (const li of liRows) {
      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, stripe_invoice_item_id, description, amount, quantity, stripe_price_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          invoiceId,
          `custom_quote_item:${li.id}`,
          li.description,
          li.quantity * li.unit_amount_cents,
          li.quantity,
          `custom_quote_line:${li.id}`,
        ],
      );
    }

    // Mark the quote as invoiced.
    await client.query(
      `UPDATE custom_quotes SET invoice_id = $2, invoiced_at = NOW() WHERE id = $1`,
      [quote.id, invoiceId],
    );

    await client.query('COMMIT');
    logger.info(
      {
        quote_id: quote.id,
        invoice_id: invoiceId,
        line_items: liRows.length,
        total_cents: quote.total_cents,
      },
      'custom_quote_to_invoice_attached',
    );
    return {
      quote_id: quote.id,
      invoice_id: invoiceId,
      line_items_attached: liRows.length,
      attached: true,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ─── S7 — expiration sweep ────────────────────────────────────────────────

export interface QuoteExpirationResult {
  expired_quote_ids: string[];
  scanned_at: string;
}

/**
 * Nightly sweep: quotes in draft/pending past their expires_at transition to 'expired'.
 * Idempotent: WHERE clause filters out already-expired rows.
 *
 * Sets decision_reason = 'Auto-expired by nightly sweep' so the reason column stays
 * populated (CHECK enforces ≥20 chars when status='expired'; the sentinel string is
 * 33 chars, which satisfies the constraint).
 */
export async function runQuoteExpirationSweep(): Promise<QuoteExpirationResult> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE custom_quotes
        SET status = 'expired',
            decision_reason = 'Auto-expired by nightly sweep'
      WHERE status IN ('draft','pending')
        AND expires_at < NOW()
      RETURNING id`,
  );
  const expiredIds = rows.map((r) => r.id);
  logger.info(
    { expired_quote_count: expiredIds.length, expired_quote_ids: expiredIds },
    'custom_quote_expiration_sweep_complete',
  );
  return { expired_quote_ids: expiredIds, scanned_at: new Date().toISOString() };
}
