// Authorized by HUB-1028 — E865 Wave 1 integration tests; control CRUD, product registration, burn-in, signal ingestion, dedup, rejection log; gated behind RUN_INTEGRATION=1

// Authorized by HUB-1771 Phase 1.7 — RUN_TAG suffix on fixture names to avoid
// UNIQUE(slug) / UNIQUE(tenant_id, name) collisions from prior aborted runs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { closeAppResources } from './_testCleanup.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const RUN_TAG = Date.now().toString();

(RUN_INTEGRATION ? describe : describe.skip)(
  'E865 Wave 1 Compliance Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let operatorToken: string;
    let tenantId: string;
    let productId: string;
    let controlUUID: string;

    // Plaintext HMAC secret returned from product registration
    let hmacSecret: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const { getPool } = await import('../db/pool.js');
      const pool = getPool();

      // Seed a tenant + product
      const { rows: tRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ($1, 'external', true)
         RETURNING id`,
        [`Compliance Wave1 Tenant ${RUN_TAG}`],
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, `Wave1 Product ${RUN_TAG}`, `wave1-product-${RUN_TAG}`],
      );
      productId = pRows[0]!.id;

      // Mint a super_admin operator JWT directly (same approach used in admin integration tests)
      const jwt = await import('jsonwebtoken');
      const secret = process.env.OPERATOR_JWT_SECRET ?? 'test-operator-secret';
      operatorToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-000000000001', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();

      // Clean up in dependency order
      if (controlUUID) {
        await pool.query(`DELETE FROM product_control_bindings WHERE control_id = $1`, [controlUUID]);
        await pool.query(`DELETE FROM compliance_signal_evidence WHERE control_id = $1`, [controlUUID]);
      }
      await pool.query(`DELETE FROM compliance_signal_rejections WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_product_registrations WHERE product_id = $1`, [productId]);
      if (controlUUID) {
        await pool.query(`DELETE FROM compliance_controls WHERE id = $1`, [controlUUID]);
      }
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await closeAppResources(app);
    });

    // ── Control registry ────────────────────────────────────────────────────────

    describe('POST /api/v1/admin/compliance/controls', () => {
      it('returns 403 without super_admin role', async () => {
        const jwt = await import('jsonwebtoken');
        const secret = process.env.OPERATOR_JWT_SECRET ?? 'test-operator-secret';
        const tenantAdminToken = jwt.default.sign(
          { operator_id: '00000000-0000-0000-0000-000000000002', role: 'product_admin', tenant_id: tenantId },
          secret,
          { expiresIn: '1h' },
        );
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/controls',
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
          payload: {
            control_id: 'CC-TEST-403',
            name: 'Test',
            tsc_category: 'CC',
            control_class: 'automated',
            eval_cadence: 'daily',
          },
        });
        expect(res.statusCode).toBe(403);
      });

      it('returns 201 and creates control', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/controls',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {
            control_id: 'CC-WAVE1-001',
            name: 'Automated Access Review',
            description: 'Verifies access review is automated',
            tsc_category: 'CC6',
            control_class: 'automated',
            eval_cadence: 'daily',
          },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { id: string };
        expect(body.id).toBeTruthy();
        controlUUID = body.id;
      });

      it('returns 400 when required fields are missing', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/controls',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { name: 'Missing Fields' },
        });
        expect(res.statusCode).toBe(400);
      });
    });

    describe('GET /api/v1/admin/compliance/controls', () => {
      it('returns array including the created control', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/controls',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as Array<{ control_id: string }>;
        expect(Array.isArray(body)).toBe(true);
        expect(body.some((c) => c.control_id === 'CC-WAVE1-001')).toBe(true);
      });
    });

    describe('PUT /api/v1/admin/compliance/controls/:controlId', () => {
      it('updates the control name', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/compliance/controls/${controlUUID}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { name: 'Updated Control Name' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { name: string };
        expect(body.name).toBe('Updated Control Name');
      });

      it('returns 404 for unknown controlId', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/compliance/controls/00000000-0000-0000-0000-000000000099',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { name: 'X' },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── Product registration ────────────────────────────────────────────────────

    describe('POST /api/v1/admin/compliance/products/:productId/register', () => {
      it('registers product and returns plaintext hmac_secret', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/products/${productId}/register`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as {
          product_id: string;
          burn_in_state: string;
          hmac_secret: string;
        };
        expect(body.product_id).toBe(productId);
        expect(body.burn_in_state).toBe('observe');
        expect(body.hmac_secret).toBeTruthy();
        hmacSecret = body.hmac_secret;
      });

      it('returns 409 on duplicate registration', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/products/${productId}/register`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(409);
      });
    });

    describe('GET /api/v1/admin/compliance/products/:productId/registration', () => {
      it('returns registration with masked hmac_secret', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/registration`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { burn_in_state: string; hmac_secret: string };
        expect(body.burn_in_state).toBe('observe');
        expect(body.hmac_secret).toBe('***');
      });
    });

    // ── Control bindings ────────────────────────────────────────────────────────

    describe('POST /api/v1/admin/compliance/products/:productId/bindings', () => {
      it('creates a binding', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/products/${productId}/bindings`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { control_id: controlUUID },
        });
        expect(res.statusCode).toBe(201);
      });

      it('is idempotent on duplicate bind', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/products/${productId}/bindings`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { control_id: controlUUID },
        });
        expect(res.statusCode).toBe(201);
      });
    });

    describe('GET /api/v1/admin/compliance/products/:productId/bindings', () => {
      it('returns active bindings with control details', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/bindings`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as Array<{ control_key: string; control_name: string }>;
        expect(Array.isArray(body)).toBe(true);
        expect(body.some((b) => b.control_key === 'CC-WAVE1-001')).toBe(true);
      });
    });

    // ── Signal ingestion ────────────────────────────────────────────────────────

    function buildSignedRequest(payload: object, secret: string): {
      body: string;
      signature: string;
    } {
      const body = JSON.stringify(payload);
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      return { body, signature };
    }

    describe('POST /api/v1/compliance/signals', () => {
      const baseSignal = () => ({
        product_id: productId,
        signal_id: `sig-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        control_id: 'CC-WAVE1-001',
        signal_type: 'automated_check',
        observed_at: new Date().toISOString(),
        payload: { result: 'pass' },
      });

      it('returns 202 received:true for valid signal', async () => {
        const sig = baseSignal();
        const { body, signature } = buildSignedRequest(sig, hmacSecret);
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature': signature },
          body,
        });
        expect(res.statusCode).toBe(202);
        const rb = JSON.parse(res.body) as { received: boolean; duplicate: boolean };
        expect(rb.received).toBe(true);
        expect(rb.duplicate).toBe(false);
      });

      it('deduplicates on same signal_id — duplicate:true', async () => {
        const sig = { ...baseSignal(), signal_id: 'dedup-signal-id-001' };
        const { body: body1, signature: sig1 } = buildSignedRequest(sig, hmacSecret);
        await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature': sig1 },
          body: body1,
        });

        const { body: body2, signature: sig2 } = buildSignedRequest(sig, hmacSecret);
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature': sig2 },
          body: body2,
        });
        expect(res.statusCode).toBe(202);
        const rb = JSON.parse(res.body) as { received: boolean; duplicate: boolean };
        expect(rb.received).toBe(true);
        expect(rb.duplicate).toBe(true);
      });

      it('marks signal as burn-in gap when product is in observe state', async () => {
        const { getPool } = await import('../db/pool.js');
        const pool = getPool();
        const sig = { ...baseSignal(), signal_id: 'burn-in-gap-signal-001' };
        const { body, signature } = buildSignedRequest(sig, hmacSecret);
        await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature': signature },
          body,
        });
        const { rows } = await pool.query<{ is_burn_in_gap: boolean }>(
          `SELECT is_burn_in_gap FROM compliance_signal_evidence WHERE signal_id = $1`,
          ['burn-in-gap-signal-001'],
        );
        expect(rows[0]!.is_burn_in_gap).toBe(true);
      });

      it('returns 202 received:false for bad signature — logs rejection', async () => {
        const sig = baseSignal();
        const body = JSON.stringify(sig);
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature': 'sha256=badhash' },
          body,
        });
        expect(res.statusCode).toBe(202);
        const rb = JSON.parse(res.body) as { received: boolean };
        expect(rb.received).toBe(false);

        const { getPool } = await import('../db/pool.js');
        const pool = getPool();
        const { rows } = await pool.query<{ rejection_reason: string }>(
          `SELECT rejection_reason FROM compliance_signal_rejections
           WHERE product_id = $1 ORDER BY received_at DESC LIMIT 1`,
          [productId],
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]!.rejection_reason).toContain('signature mismatch');
      });

      it('returns 202 received:false when product not registered', async () => {
        const fakeProductId = '00000000-0000-0000-0000-000000000099';
        const sig = { ...baseSignal(), product_id: fakeProductId };
        const { body, signature } = buildSignedRequest(sig, hmacSecret);
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature': signature },
          body,
        });
        expect(res.statusCode).toBe(202);
        expect((JSON.parse(res.body) as { received: boolean }).received).toBe(false);
      });

      it('returns 202 received:false when X-Hub-Signature header is missing', async () => {
        const sig = baseSignal();
        const body = JSON.stringify(sig);
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        expect(res.statusCode).toBe(202);
        expect((JSON.parse(res.body) as { received: boolean }).received).toBe(false);
      });
    });

    // ── Burn-in promote ─────────────────────────────────────────────────────────

    describe('POST /api/v1/admin/compliance/products/:productId/promote', () => {
      it('promotes product from observe to enforced', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/products/${productId}/promote`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { burn_in_state: string };
        expect(body.burn_in_state).toBe('enforced');
      });

      it('returns 404 when product already enforced', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/products/${productId}/promote`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── Control deactivate ──────────────────────────────────────────────────────

    describe('DELETE /api/v1/admin/compliance/controls/:controlId', () => {
      it('soft-deactivates the control', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/compliance/controls/${controlUUID}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(204);
      });

      it('returns 404 on second deactivate (already inactive)', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/compliance/controls/${controlUUID}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });
  },
);
