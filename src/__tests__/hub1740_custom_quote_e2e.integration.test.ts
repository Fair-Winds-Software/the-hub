// Authorized by HUB-1740 (E-V2-PP-2 S11, HUB-1726, HUB-1701) — End-to-end integration test
// exercising create → approve → run invoice pipeline → invoice line items appear + immutability
// after approval + self-approve blocked + expiration flow. Consolidates coverage across
// HUB-1733/1734/1735/1736 into one flow-shaped test file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { runQuoteToInvoicePipeline } from '../queues/customQuoteJobs.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const CONNECTION_STRING = process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1740-${Date.now()}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1740 (E-V2-PP-2 S11): end-to-end custom-quote pipeline',
  () => {
    let app: FastifyInstance;
    let client: Client;
    let creatorToken: string;
    let approverToken: string;
    const creatorId = '00000000-0000-0000-0000-000000007777';
    const approverId = '00000000-0000-0000-0000-000000008888';
    let tenantId: string;
    let productId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

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

      const jwt = await import('jsonwebtoken');
      const secret = process.env['OPERATOR_JWT_SECRET']!;
      creatorToken = jwt.default.sign(
        { operator_id: creatorId, role: 'super_admin', tenant_id: null },
        secret, { expiresIn: '1h' },
      );
      approverToken = jwt.default.sign(
        { operator_id: approverId, role: 'super_admin', tenant_id: null },
        secret, { expiresIn: '1h' },
      );
    });

    afterAll(async () => {
      // Delete invoices this test created (identified via internal + tenant scope).
      await client.query(
        `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE tenant_id = $1)`,
        [tenantId],
      );
      await client.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenantId]);
      // Approvals are immutable; leave them + the parent quotes they hold alive.
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
      await app.close();
    });

    const creatorAuth = () => ({ Authorization: `Bearer ${creatorToken}` });
    const approverAuth = () => ({ Authorization: `Bearer ${approverToken}` });

    it('happy path: create → approve → run pipeline → invoice line items exist', async () => {
      // 1. Create quote via API.
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [
            { description: 'Consulting', quantity: 40, unit_amount_cents: 25000 },
            { description: 'Setup fee', quantity: 1, unit_amount_cents: 500000 },
          ],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;

      // 2. Approve via API (different operator = two-role attestation).
      const apprRes = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: approverAuth(),
        payload: { reason: 'Approved: quote reviewed by finance + legal; terms accepted.' },
      });
      expect(apprRes.statusCode).toBe(200);
      const apprBody = JSON.parse(apprRes.body) as { status: string };
      expect(apprBody.status).toBe('approved');

      // 3. Run the invoice pipeline job.
      const pipeline = await runQuoteToInvoicePipeline(quoteId);
      expect(pipeline.attached).toBe(true);
      expect(pipeline.line_items_attached).toBe(2);

      // 4. Verify the invoice + line items exist and match expected totals.
      const invRes = await client.query<{ external_provider: string; amount_due: number }>(
        `SELECT external_provider, amount_due FROM invoices WHERE id = $1`,
        [pipeline.invoice_id],
      );
      expect(invRes.rows[0]!.external_provider).toBe('internal');
      // 40 * 25000 + 1 * 500000 = 1,500,000
      expect(invRes.rows[0]!.amount_due).toBe(1500000);
      const liRes = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM invoice_items WHERE invoice_id = $1`,
        [pipeline.invoice_id],
      );
      expect(parseInt(liRes.rows[0]!.n, 10)).toBe(2);

      // 5. Verify custom_quotes.invoice_id linkage.
      const qRes = await client.query<{ invoice_id: string; invoiced_at: string | null }>(
        `SELECT invoice_id, invoiced_at FROM custom_quotes WHERE id = $1`, [quoteId],
      );
      expect(qRes.rows[0]!.invoice_id).toBe(pipeline.invoice_id);
      expect(qRes.rows[0]!.invoiced_at).not.toBeNull();
    });

    it('self-approve is blocked (creator = approver → 403)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [{ description: 'X', quantity: 1, unit_amount_cents: 100 }],
        },
      });
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;
      const apprRes = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: creatorAuth(), // same operator!
        payload: { reason: 'This is a valid-length reason that should be rejected due to self.' },
      });
      expect(apprRes.statusCode).toBe(403);
    });

    it('line items immutable after approval (23514 on UPDATE)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [{ description: 'Locked', quantity: 1, unit_amount_cents: 100 }],
        },
      });
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: approverAuth(),
        payload: { reason: 'Approving with sufficient reason text for line-item lock test.' },
      });
      await expect(
        client.query(
          `UPDATE custom_quote_line_items SET quantity = 5 WHERE quote_id = $1`,
          [quoteId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('invoice pipeline is idempotent (re-run produces no duplicate items)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [{ description: 'Idem', quantity: 1, unit_amount_cents: 100 }],
        },
      });
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: approverAuth(),
        payload: { reason: 'Testing pipeline idempotency in end-to-end flow.' },
      });
      const first = await runQuoteToInvoicePipeline(quoteId);
      expect(first.attached).toBe(true);
      const second = await runQuoteToInvoicePipeline(quoteId);
      expect(second.attached).toBe(false);
      expect(second.invoice_id).toBe(first.invoice_id);
      const liRes = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM invoice_items WHERE invoice_id = $1`,
        [first.invoice_id],
      );
      expect(parseInt(liRes.rows[0]!.n, 10)).toBe(1);
    });

    it('expired quote at approval attempt: 409 + auto-transition to expired', async () => {
      // Insert directly with past expires_at (API defaults +30d).
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO custom_quotes (tenant_id, product_id, operator_id, expires_at)
         VALUES ($1, $2, $3, NOW() - INTERVAL '1 day') RETURNING id`,
        [tenantId, productId, creatorId],
      );
      const quoteId = rows[0]!.id;
      await client.query(
        `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
         VALUES ($1, 'Expired-item', 1, 100, 0)`,
        [quoteId],
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: approverAuth(),
        payload: { reason: 'Attempting to approve an already-expired quote for coverage.' },
      });
      expect(res.statusCode).toBe(409);
      const check = await client.query<{ status: string }>(
        `SELECT status FROM custom_quotes WHERE id = $1`, [quoteId],
      );
      expect(check.rows[0]!.status).toBe('expired');
    });
  },
);
