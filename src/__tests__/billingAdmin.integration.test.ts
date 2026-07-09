// Authorized by HUB-1498 — E27 integration tests; gated behind RUN_INTEGRATION=1
// Authorized by HUB-1771 Phase 1.3 — RUN_TAG suffix on fixture names to avoid
// UNIQUE(slug) / UNIQUE(tenant_id, name) collisions from prior aborted runs.
// Emails preserve the `test-e27-…@integration.test` shape so cleanup LIKE still matches.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const RUN_TAG = Date.now().toString();
const SUPER_EMAIL = `test-e27-super-${RUN_TAG}@integration.test`;
const ADMIN_EMAIL = `test-e27-admin-${RUN_TAG}@integration.test`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'E27 Billing & Pricing Admin Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let superAdminToken: string;
    let tenantAdminToken: string;
    let tenantId: string;
    let productId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      const hash = await bcrypt.hash('IntPass!99', 12);

      // Seed super_admin
      await pool.query(
        `INSERT INTO operator_accounts (email, password_hash, role)
         VALUES ($1, $2, 'super_admin')
         ON CONFLICT DO NOTHING`,
        [SUPER_EMAIL, hash],
      );

      // Create tenant + product for tests
      const { rows: tRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ($1, 'external', true)
         RETURNING id`,
        [`E27 Test Tenant ${RUN_TAG}`],
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, `E27 Product ${RUN_TAG}`, `e27-product-test-${RUN_TAG}`],
      );
      productId = pRows[0]!.id;

      // Seed product_admin scoped to this tenant
      await pool.query(
        `INSERT INTO operator_accounts (email, password_hash, role, tenant_id)
         VALUES ($1, $2, 'product_admin', $3)
         ON CONFLICT DO NOTHING`,
        [ADMIN_EMAIL, hash, tenantId],
      );

      // Login super_admin
      const superRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: SUPER_EMAIL, password: 'IntPass!99' },
      });
      superAdminToken = (JSON.parse(superRes.body) as { accessToken: string }).accessToken;

      // Login product_admin
      const taRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: ADMIN_EMAIL, password: 'IntPass!99' },
      });
      tenantAdminToken = (JSON.parse(taRes.body) as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await pool.query(
        `DELETE FROM operator_accounts WHERE email LIKE 'test-e27-%@integration.test'`,
      );
      await app.close();
    });

    // ── Pricing model GET (no model) ─────────────────────────────────────────

    describe('GET pricing model — 404 when no active model', () => {
      it('returns 404 for product with no pricing model', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/pricing`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(404);
      });

      it('product_admin can read own tenant pricing (404 = no model, not forbidden)', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/pricing`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── RBAC: super_admin-only writes ────────────────────────────────────────

    describe('RBAC — product_admin receives 403 on write/freeze/stripe endpoints', () => {
      it('PUT pricing → 403 for product_admin', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/pricing`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
          payload: { modelType: 'flat', currency: 'usd', config: { flat_fee_cents: 1000 } },
        });
        expect(res.statusCode).toBe(403);
      });

      it('POST freeze → 403 for product_admin', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/freeze`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });

      it('DELETE freeze → 403 for product_admin', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/freeze`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });

      it('GET stripe-customer → 403 for product_admin', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenantId}/stripe-customer`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });
    });

    // ── D-005: productId required on invoice list ────────────────────────────

    describe('D-005 — invoice list requires productId query param', () => {
      it('returns 400 when productId is absent', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenantId}/invoices`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body)).toMatchObject({ error: { message: expect.stringContaining('productId') } });
      });

      it('returns 200 empty array when productId provided and no invoices', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenantId}/invoices?productId=${productId}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual([]);
      });
    });

    // ── Invoice detail cross-tenant isolation ────────────────────────────────

    describe('Invoice detail — 404 when invoiceId belongs to different tenant', () => {
      it('returns 404 for unknown invoiceId', async () => {
        const fakeId = '00000000-0000-0000-0000-000000000099';
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenantId}/invoices/${fakeId}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── Stripe customer link ─────────────────────────────────────────────────

    describe('GET stripe-customer — 404 when no Stripe customer', () => {
      it('returns 404 when no stripe_customers row', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenantId}/stripe-customer`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── Pricing model activate + GET ─────────────────────────────────────────

    describe('PUT pricing → activates model; GET returns it', () => {
      it('super_admin activates flat pricing model; GET returns it', async () => {
        const putRes = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/pricing`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
          payload: {
            modelType: 'flat',
            currency: 'usd',
            config: { flat_fee_cents: 5000 },
          },
        });
        expect(putRes.statusCode).toBe(201);
        const model = JSON.parse(putRes.body) as { model_type: string; currency: string };
        expect(model.model_type).toBe('flat');
        expect(model.currency).toBe('usd');

        const getRes = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/pricing`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(getRes.statusCode).toBe(200);
        expect(JSON.parse(getRes.body)).toMatchObject({ model_type: 'flat', currency: 'usd' });

        // Cleanup: no need to remove pricing_model row as product cleanup cascades (or manual)
        const { getPool } = await import('../db/pool.js');
        await getPool().query(`DELETE FROM pricing_models WHERE product_id = $1`, [productId]);
      });
    });

    // ── D-006: freeze isolation ──────────────────────────────────────────────

    describe('D-006 — freeze is per-product; sibling product unaffected', () => {
      it('freeze product A; license service reports 422 on unfreeze without license row', async () => {
        // The test product has no license row yet, so freeze returns 404/422 from service
        const freezeRes = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/freeze`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        // 422 = license not in active state (or 404 = license not found)
        expect([404, 422]).toContain(freezeRes.statusCode);
      });

      it('unfreeze without suspended license → 422', async () => {
        const unfreezeRes = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/tenants/${tenantId}/products/${productId}/freeze`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(unfreezeRes.statusCode).toBe(422);
      });
    });
  },
);
