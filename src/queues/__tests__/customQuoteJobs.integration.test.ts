// Authorized by HUB-1735 + HUB-1736 (E-V2-PP-2 S6/S7, HUB-1726, HUB-1701) —
// Integration tests for the quote → invoice pipeline + expiration sweep jobs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  runQuoteToInvoicePipeline,
  runQuoteExpirationSweep,
} from '../customQuoteJobs.js';
import { AppError } from '../../errors/AppError.js';

const CONNECTION_STRING = process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1701PP2JOBS-${Date.now()}`;

let client: Client;
let tenantId: string;
let productId: string;
const creatorId = '00000000-0000-0000-0000-000000005555';
const approverId = '00000000-0000-0000-0000-000000006666';

async function insertApprovedQuote(): Promise<string> {
  // Create a draft quote with line items, then approve it via direct SQL (skipping
  // the API layer to keep this test focused on the job).
  const { rows: qRows } = await client.query<{ id: string }>(
    `INSERT INTO custom_quotes (tenant_id, product_id, operator_id, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days') RETURNING id`,
    [tenantId, productId, creatorId],
  );
  const quoteId = qRows[0]!.id;
  await client.query(
    `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
     VALUES ($1, 'A', 2, 5000, 0), ($1, 'B', 1, 15000, 1)`,
    [quoteId],
  );
  // Bump to pending (transition guard blocks draft→approved directly).
  await client.query(`UPDATE custom_quotes SET status = 'pending' WHERE id = $1`, [quoteId]);
  await client.query(
    `INSERT INTO custom_quote_approvals (quote_id, approver_operator_id, decision, reason)
     VALUES ($1, $2, 'approved', 'Auto-created for job integration test coverage.')`,
    [quoteId, approverId],
  );
  await client.query(`UPDATE custom_quotes SET status = 'approved' WHERE id = $1`, [quoteId]);
  return quoteId;
}

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();

  const tRes = await client.query<{ id: string }>(
    `INSERT INTO tenants (name, tenant_type) VALUES ($1, 'internal') RETURNING id`,
    [RUN_TAG],
  );
  tenantId = tRes.rows[0]!.id;
  const pRes = await client.query<{ id: string }>(
    `INSERT INTO products (slug, name, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${RUN_TAG.toLowerCase()}-prod`, `${RUN_TAG} product`, tenantId],
  );
  productId = pRes.rows[0]!.id;
});

afterAll(async () => {
  await client.query(
    `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE tenant_id = $1)`,
    [tenantId],
  );
  await client.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
  await client.query(
    `DELETE FROM custom_quotes WHERE tenant_id = $1 AND id NOT IN (SELECT quote_id FROM custom_quote_approvals)`,
    [tenantId],
  );
  await client.query(
    `DELETE FROM products WHERE id = $1 AND id NOT IN (SELECT product_id FROM custom_quotes)`,
    [productId],
  );
  await client.query(
    `DELETE FROM tenants WHERE id = $1 AND id NOT IN (SELECT tenant_id FROM custom_quotes)`,
    [tenantId],
  );
  await client.end();
});

// ── HUB-1735 (S6): quote → invoice pipeline ───────────────────────────────
describe('HUB-1735 (S6): runQuoteToInvoicePipeline', () => {
  it('creates an internal invoice + attaches all line items on first run', async () => {
    const quoteId = await insertApprovedQuote();
    const result = await runQuoteToInvoicePipeline(quoteId);
    expect(result.attached).toBe(true);
    expect(result.line_items_attached).toBe(2);
    // Verify the invoice was created with external_provider='internal'.
    const invRes = await client.query<{ external_provider: string; amount_due: number }>(
      `SELECT external_provider, amount_due FROM invoices WHERE id = $1`, [result.invoice_id],
    );
    expect(invRes.rows[0]!.external_provider).toBe('internal');
    expect(invRes.rows[0]!.amount_due).toBe(2 * 5000 + 1 * 15000);
    // Verify invoice_items count.
    const liRes = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM invoice_items WHERE invoice_id = $1`,
      [result.invoice_id],
    );
    expect(parseInt(liRes.rows[0]!.n, 10)).toBe(2);
    // Verify quote.invoice_id populated.
    const qRes = await client.query<{ invoice_id: string | null; invoiced_at: string | null }>(
      `SELECT invoice_id, invoiced_at FROM custom_quotes WHERE id = $1`, [quoteId],
    );
    expect(qRes.rows[0]!.invoice_id).toBe(result.invoice_id);
    expect(qRes.rows[0]!.invoiced_at).not.toBeNull();
  });

  it('is idempotent — re-running produces no new items (AC 3)', async () => {
    const quoteId = await insertApprovedQuote();
    const first = await runQuoteToInvoicePipeline(quoteId);
    expect(first.attached).toBe(true);
    const second = await runQuoteToInvoicePipeline(quoteId);
    expect(second.attached).toBe(false);
    expect(second.invoice_id).toBe(first.invoice_id);
    expect(second.line_items_attached).toBe(0);
    // Verify no duplicate invoice_items.
    const liRes = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM invoice_items WHERE invoice_id = $1`,
      [first.invoice_id],
    );
    expect(parseInt(liRes.rows[0]!.n, 10)).toBe(2);
  });

  it('throws 404 for non-existent quote', async () => {
    await expect(
      runQuoteToInvoicePipeline('00000000-0000-0000-0000-000000000abc'),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      runQuoteToInvoicePipeline('00000000-0000-0000-0000-000000000abc'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 400 for a non-approved quote', async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO custom_quotes (tenant_id, product_id, operator_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days') RETURNING id`,
      [tenantId, productId, creatorId],
    );
    await client.query(
      `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
       VALUES ($1, 'X', 1, 100, 0)`,
      [rows[0]!.id],
    );
    await expect(runQuoteToInvoicePipeline(rows[0]!.id)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('must be approved'),
    });
  });
});

// ── HUB-1736 (S7): expiration sweep ───────────────────────────────────────
describe('HUB-1736 (S7): runQuoteExpirationSweep', () => {
  it('transitions draft + pending quotes past expires_at to expired (AC 2)', async () => {
    // Seed 2 expired (one draft, one pending) + 1 not-yet-expired + 1 already-expired.
    const inserts = [
      { status: 'draft', expires_at: 'NOW() - INTERVAL \'1 day\'' },
      { status: 'pending', expires_at: 'NOW() - INTERVAL \'2 days\'' },
      { status: 'draft', expires_at: 'NOW() + INTERVAL \'1 day\'' },
      { status: 'draft', expires_at: 'NOW() - INTERVAL \'3 days\'' }, // Will be pre-expired below.
    ];
    const ids: string[] = [];
    for (const ins of inserts) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO custom_quotes (tenant_id, product_id, operator_id, status, expires_at)
         VALUES ($1, $2, $3, $4, ${ins.expires_at}) RETURNING id`,
        [tenantId, productId, creatorId, ins.status],
      );
      ids.push(rows[0]!.id);
    }
    // Pre-expire the 4th one to test idempotency.
    await client.query(
      `UPDATE custom_quotes SET status = 'expired', decision_reason = 'Pre-expired for test coverage.' WHERE id = $1`,
      [ids[3]],
    );

    const result = await runQuoteExpirationSweep();
    // The two expired-draft-or-pending should be swept; the third (future) and fourth (already expired) untouched.
    expect(result.expired_quote_ids).toEqual(expect.arrayContaining([ids[0]!, ids[1]!]));
    expect(result.expired_quote_ids).not.toContain(ids[2]!);
    expect(result.expired_quote_ids).not.toContain(ids[3]!);
    // Verify DB state.
    const { rows } = await client.query<{ id: string; status: string; decision_reason: string }>(
      `SELECT id, status, decision_reason FROM custom_quotes WHERE id = ANY($1)`, [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids[0]!)!.status).toBe('expired');
    expect(byId.get(ids[0]!)!.decision_reason).toBe('Auto-expired by nightly sweep');
    expect(byId.get(ids[1]!)!.status).toBe('expired');
    expect(byId.get(ids[2]!)!.status).toBe('draft');
    expect(byId.get(ids[3]!)!.status).toBe('expired');
  });

  it('is idempotent — second run returns 0 expired', async () => {
    const first = await runQuoteExpirationSweep();
    const second = await runQuoteExpirationSweep();
    expect(second.expired_quote_ids.length).toBeLessThanOrEqual(first.expired_quote_ids.length);
    // If nothing new was inserted since the first sweep, expect 0.
    expect(second.expired_quote_ids).toEqual([]);
  });
});
