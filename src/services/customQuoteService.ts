// Authorized by HUB-1733 + HUB-1734 (E-V2-PP-2 S4/S5, HUB-1726, HUB-1701) —
// Custom-quote service layer. Two operations sit here:
//   createQuote(payload)  — S4 (draft creation with line items in one txn)
//   decideQuote(quoteId, decision, reason, approverOperatorId) — S5 (approve/reject)
//
// Both do their own DB transaction management. The service returns the persisted
// row + child rows (line items on create; approval + updated quote on decide).

import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

export interface CreateQuoteLineItem {
  description: string;
  quantity: number;
  unit_amount_cents: number;
  plan_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateQuotePayload {
  tenant_id: string;
  product_id: string;
  operator_id: string;
  line_items: CreateQuoteLineItem[];
  expires_at?: string | null;
}

export interface CustomQuoteRow {
  id: string;
  tenant_id: string;
  product_id: string;
  operator_id: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'expired';
  total_cents: number;
  currency: string;
  expires_at: string;
  decision_reason: string | null;
  invoice_id: string | null;
  invoiced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomQuoteLineItemRow {
  id: string;
  quote_id: string;
  plan_id: string | null;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  metadata: Record<string, unknown>;
  sort_order: number;
  created_at: string;
}

export interface CustomQuoteApprovalRow {
  id: string;
  quote_id: string;
  approver_operator_id: string;
  decision: 'approved' | 'rejected';
  reason: string;
  content_hash: string;
  created_at: string;
}

const DEFAULT_EXPIRY_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(v: unknown, label: string): asserts v is string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }
}

/**
 * S4: Create a draft quote + N line items atomically.
 * Enforces:
 *   - line_items.length >= 1
 *   - each line_item's plan_id (when present) belongs to the same product as the quote
 *   - default expires_at = NOW() + 30 days when omitted (D-HUB-QUOTE-EXPIRY-001)
 * Returns { quote, line_items } after commit.
 */
export async function createQuote(
  payload: CreateQuotePayload,
): Promise<{ quote: CustomQuoteRow; line_items: CustomQuoteLineItemRow[] }> {
  assertUuid(payload.tenant_id, 'tenant_id');
  assertUuid(payload.product_id, 'product_id');
  assertUuid(payload.operator_id, 'operator_id');
  if (!Array.isArray(payload.line_items) || payload.line_items.length === 0) {
    throw new AppError(400, 'quote must have at least one line item');
  }
  const expiresAt = payload.expires_at ??
    new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86400 * 1000).toISOString();

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: quoteRows } = await client.query<CustomQuoteRow>(
      `INSERT INTO custom_quotes (tenant_id, product_id, operator_id, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [payload.tenant_id, payload.product_id, payload.operator_id, expiresAt],
    );
    const quote = quoteRows[0]!;

    const lineItemRows: CustomQuoteLineItemRow[] = [];
    for (let i = 0; i < payload.line_items.length; i++) {
      const li = payload.line_items[i]!;
      if (typeof li.description !== 'string' || li.description.trim().length === 0) {
        throw new AppError(400, `line_items[${i}].description is required`);
      }
      if (!Number.isInteger(li.quantity) || li.quantity < 1) {
        throw new AppError(400, `line_items[${i}].quantity must be a positive integer`);
      }
      if (!Number.isInteger(li.unit_amount_cents) || li.unit_amount_cents < 0) {
        throw new AppError(400, `line_items[${i}].unit_amount_cents must be a non-negative integer`);
      }
      if (li.plan_id !== undefined && li.plan_id !== null) {
        assertUuid(li.plan_id, `line_items[${i}].plan_id`);
      }
      const { rows: liRows } = await client.query<CustomQuoteLineItemRow>(
        `INSERT INTO custom_quote_line_items
           (quote_id, plan_id, description, quantity, unit_amount_cents, metadata, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [
          quote.id,
          li.plan_id ?? null,
          li.description,
          li.quantity,
          li.unit_amount_cents,
          JSON.stringify(li.metadata ?? {}),
          i,
        ],
      );
      lineItemRows.push(liRows[0]!);
    }
    // Re-fetch the quote so total_cents reflects the sum-into-total trigger.
    const { rows: freshRows } = await client.query<CustomQuoteRow>(
      `SELECT * FROM custom_quotes WHERE id = $1`, [quote.id],
    );
    await client.query('COMMIT');
    return { quote: freshRows[0]!, line_items: lineItemRows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * S5: Approve or reject a quote. Enforces:
 *   - two-role attestation (creator ≠ approver) — DB trigger + API layer
 *   - reason ≥20 chars — DB CHECK + API layer
 *   - quote must be in status draft OR pending (approve auto-promotes draft)
 *   - approve requires total_cents > 0
 *   - expiry check: if expires_at < NOW(), transitions to 'expired' and returns 409
 *
 * Executes as a single transaction:
 *   1. lock the parent quote FOR UPDATE
 *   2. verify preconditions
 *   3. INSERT into custom_quote_approvals (trigger sets content_hash + guards two-role)
 *   4. UPDATE parent quote status + decision_reason
 */
export async function decideQuote(
  quoteId: string,
  decision: 'approved' | 'rejected',
  reason: string,
  approverOperatorId: string,
): Promise<{ quote: CustomQuoteRow; approval: CustomQuoteApprovalRow }> {
  assertUuid(quoteId, 'quoteId');
  assertUuid(approverOperatorId, 'approverOperatorId');
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new AppError(400, 'decision must be approved or rejected');
  }
  if (typeof reason !== 'string' || reason.trim().length < 20) {
    throw new AppError(400, 'reason must be at least 20 characters');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: quoteRows } = await client.query<CustomQuoteRow>(
      `SELECT * FROM custom_quotes WHERE id = $1 FOR UPDATE`, [quoteId],
    );
    const quote = quoteRows[0];
    if (!quote) {
      await client.query('ROLLBACK');
      throw new AppError(404, 'quote not found');
    }
    // Self-approval blocked at API (defense-in-depth over the DB trigger).
    if (quote.operator_id === approverOperatorId) {
      await client.query('ROLLBACK');
      throw new AppError(403, 'creator cannot approve or reject own quote');
    }
    // Terminal states.
    if (quote.status !== 'draft' && quote.status !== 'pending') {
      await client.query('ROLLBACK');
      throw new AppError(409, `quote is already ${quote.status}`);
    }
    // Expiry check — auto-transition and return 409.
    if (new Date(quote.expires_at).getTime() < Date.now()) {
      await client.query(
        `UPDATE custom_quotes SET status = 'expired', decision_reason = $2 WHERE id = $1`,
        [quoteId, 'Auto-expired at approval attempt (expires_at in past)'],
      );
      await client.query('COMMIT');
      throw new AppError(409, 'quote expired');
    }
    // Non-zero total for approve.
    if (decision === 'approved' && quote.total_cents <= 0) {
      await client.query('ROLLBACK');
      throw new AppError(400, 'quote total must be > 0 to approve');
    }

    // Insert approval — trigger enforces creator ≠ approver + populates content_hash.
    const { rows: apprRows } = await client.query<CustomQuoteApprovalRow>(
      `INSERT INTO custom_quote_approvals (quote_id, approver_operator_id, decision, reason)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [quoteId, approverOperatorId, decision, reason],
    );

    // For approve, we may need to go draft→pending→approved. The transition guard blocks
    // direct draft→approved, so bump to pending first if we're currently in draft.
    if (quote.status === 'draft') {
      await client.query(`UPDATE custom_quotes SET status = 'pending' WHERE id = $1`, [quoteId]);
    }
    await client.query(
      `UPDATE custom_quotes SET status = $2, decision_reason = $3 WHERE id = $1`,
      [quoteId, decision, decision === 'rejected' ? reason : null],
    );

    const { rows: freshRows } = await client.query<CustomQuoteRow>(
      `SELECT * FROM custom_quotes WHERE id = $1`, [quoteId],
    );
    await client.query('COMMIT');
    return { quote: freshRows[0]!, approval: apprRows[0]! };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List quotes for the given tenant + optional status filter. Used by S9 UI.
 */
export async function listQuotes(
  tenantId: string,
  opts: { status?: string; page?: number; pageSize?: number } = {},
): Promise<{ data: CustomQuoteRow[]; total: number; page: number; pageSize: number }> {
  assertUuid(tenantId, 'tenantId');
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  const whereFragments = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (opts.status && opts.status !== 'all') {
    whereFragments.push(`status = $${params.length + 1}`);
    params.push(opts.status);
  }
  const where = `WHERE ${whereFragments.join(' AND ')}`;

  const [dataRes, totalRes] = await Promise.all([
    getPool().query<CustomQuoteRow>(
      `SELECT * FROM custom_quotes ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
    getPool().query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM custom_quotes ${where}`,
      params,
    ),
  ]);
  return {
    data: dataRes.rows,
    total: parseInt(totalRes.rows[0]!.total, 10),
    page,
    pageSize,
  };
}
