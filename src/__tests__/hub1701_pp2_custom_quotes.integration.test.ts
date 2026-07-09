// Authorized by HUB-1733 + HUB-1734 (E-V2-PP-2 S4/S5, HUB-1726, HUB-1701) —
// Custom-quote API integration tests. Exercises POST create + POST approve/reject
// via Fastify.inject() with two operator JWTs (creator + approver) to verify the
// two-role attestation invariant end-to-end.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const CONNECTION_STRING = process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1701PP2API-${Date.now()}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1733/1734 (E-V2-PP-2 S4/S5): custom-quote API',
  () => {
    let app: FastifyInstance;
    let client: Client;
    let creatorToken: string;
    let approverToken: string;
    const creatorId = '00000000-0000-0000-0000-000000003333';
    const approverId = '00000000-0000-0000-0000-000000004444';
    let tenantId: string;
    let productId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      client = new Client({ connectionString: CONNECTION_STRING });
      await client.connect();

      // Seed tenant + product.
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
      // Clean up quotes that don't have immutable approvals.
      await client.query(
        `DELETE FROM custom_quotes
          WHERE tenant_id = $1
            AND id NOT IN (SELECT quote_id FROM custom_quote_approvals)`,
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
      await closeAppResources(app);
    });

    const creatorAuth = () => ({ Authorization: `Bearer ${creatorToken}` });
    const approverAuth = () => ({ Authorization: `Bearer ${approverToken}` });

    it('POST creates a draft quote with line items (S4)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [
            { description: 'Consulting Q1', quantity: 20, unit_amount_cents: 25000 },
            { description: 'Setup fee', quantity: 1, unit_amount_cents: 100000 },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as {
        id: string; status: string; total_cents: number; line_items: Array<unknown>;
      };
      expect(body.status).toBe('draft');
      expect(body.total_cents).toBe(20 * 25000 + 100000);
      expect(body.line_items).toHaveLength(2);
    });

    it('POST create rejects missing tenant_id with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          product_id: productId,
          line_items: [{ description: 'x', quantity: 1, unit_amount_cents: 100 }],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST create rejects empty line_items with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: { tenant_id: tenantId, product_id: productId, line_items: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST approve happy path — different operator approves (two-role) (S5)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [{ description: 'A', quantity: 1, unit_amount_cents: 500 }],
        },
      });
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;

      const apprRes = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: approverAuth(),
        payload: { reason: 'This quote reflects the negotiated Q4 partnership terms; approved.' },
      });
      expect(apprRes.statusCode).toBe(200);
      const body = JSON.parse(apprRes.body) as {
        status: string; approval: { decision: string; content_hash: string };
      };
      expect(body.status).toBe('approved');
      expect(body.approval.decision).toBe('approved');
      expect(body.approval.content_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('POST approve — creator approves own quote → 403 (S5 AC 3)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [{ description: 'A', quantity: 1, unit_amount_cents: 100 }],
        },
      });
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: creatorAuth(),
        payload: { reason: 'This is my quote and I want to approve it myself illegally.' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('creator cannot approve');
    });

    it('POST approve — reason < 20 chars → 400 (S5 AC 4)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [{ description: 'A', quantity: 1, unit_amount_cents: 100 }],
        },
      });
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: approverAuth(),
        payload: { reason: 'too short' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST approve — expired quote → 409 + auto-transition to expired (S5 AC 8)', async () => {
      // Insert a quote directly with past expires_at.
      const insertRes = await client.query<{ id: string }>(
        `INSERT INTO custom_quotes (tenant_id, product_id, operator_id, expires_at)
         VALUES ($1, $2, $3, NOW() - INTERVAL '1 day') RETURNING id`,
        [tenantId, productId, creatorId],
      );
      const quoteId = insertRes.rows[0]!.id;
      await client.query(
        `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
         VALUES ($1, 'X', 1, 100, 0)`,
        [quoteId],
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: approverAuth(),
        payload: { reason: 'Attempting to approve this expired quote should fail cleanly.' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain('quote expired');
      // Auto-transitioned to expired in the same request.
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM custom_quotes WHERE id = $1`, [quoteId],
      );
      expect(rows[0]!.status).toBe('expired');
    });

    it('POST reject — records approval with decision=rejected + parent status transitions', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [{ description: 'A', quantity: 1, unit_amount_cents: 500 }],
        },
      });
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/reject`,
        headers: approverAuth(),
        payload: { reason: 'Rejected: this contract violates our vendor risk policy for external services.' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        status: string; decision_reason: string; approval: { decision: string };
      };
      expect(body.status).toBe('rejected');
      expect(body.decision_reason).toContain('violates');
      expect(body.approval.decision).toBe('rejected');
    });

    it('GET list returns paginated quotes for tenant (S9)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/billing/quotes?tenant_id=${tenantId}&pageSize=100`,
        headers: creatorAuth(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: Array<Record<string, unknown>>; total: number; page: number; pageSize: number;
      };
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(100);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('GET :id returns quote with line_items + approvals', async () => {
      // Create + approve a quote.
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/billing/quotes',
        headers: creatorAuth(),
        payload: {
          tenant_id: tenantId,
          product_id: productId,
          line_items: [{ description: 'A', quantity: 1, unit_amount_cents: 1000 }],
        },
      });
      const quoteId = (JSON.parse(createRes.body) as { id: string }).id;
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/billing/quotes/${quoteId}/approve`,
        headers: approverAuth(),
        payload: { reason: 'Approving with plenty of characters here for the reason field.' },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/billing/quotes/${quoteId}`,
        headers: creatorAuth(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        status: string;
        line_items: Array<unknown>;
        approvals: Array<{ decision: string }>;
      };
      expect(body.status).toBe('approved');
      expect(body.line_items).toHaveLength(1);
      expect(body.approvals).toHaveLength(1);
      expect(body.approvals[0]!.decision).toBe('approved');
    });
  },
);
