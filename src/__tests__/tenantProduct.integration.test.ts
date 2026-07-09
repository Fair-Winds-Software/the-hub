// Authorized by HUB-1128 — E26 integration tests; gated behind RUN_INTEGRATION=1
// Authorized by HUB-1771 Phase 1.6 — RUN_TAG suffix on fixture names to avoid
// UNIQUE-name collisions from prior aborted runs. Applies to seed operator email
// AND every inline payload name (create endpoints don't hard-delete on soft-delete
// so prior-run rows persist and block re-inserts).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { cleanupProduct, cleanupTenant } from './_testCleanup.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const RUN_TAG = Date.now().toString();
const SUPER_EMAIL = `test-e26-super-${RUN_TAG}@integration.test`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'E26 Tenant + Product Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let superAdminToken: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      // Seed a super_admin for all tests in this suite
      const { getPool } = await import('../db/pool.js');
      const hash = await bcrypt.hash('IntPass!99', 12);
      await getPool().query(
        `INSERT INTO operator_accounts (email, password_hash, role)
         VALUES ($1, $2, 'super_admin')
         ON CONFLICT DO NOTHING`,
        [SUPER_EMAIL, hash],
      );

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: SUPER_EMAIL, password: 'IntPass!99' },
      });
      const { accessToken } = JSON.parse(loginRes.body) as { accessToken: string };
      superAdminToken = accessToken;
    });

    afterAll(async () => {
      await app.close();
    });

    afterEach(async () => {
      const { getPool } = await import('../db/pool.js');
      await getPool().query(
        `DELETE FROM operator_accounts WHERE email LIKE 'test-e26-%@integration.test'`,
      );
    });

    // ── Seed idempotency ──────────────────────────────────────────────────────

    describe('D-004 seed idempotency — Maverick Launch tenant', () => {
      it('running seedInternalTenant twice results in exactly one Maverick Launch row', async () => {
        const { getPool } = await import('../db/pool.js');
        const { seedInternalTenant } = await import('../seeds/internalTenant.js');
        await seedInternalTenant(getPool());
        await seedInternalTenant(getPool());
        const { rows } = await getPool().query(
          `SELECT count(*)::int AS cnt FROM tenants WHERE name = 'Maverick Launch' AND tenant_type = 'internal'`,
        );
        expect(rows[0]!.cnt).toBe(1);
      });
    });

    // ── Tenant CRUD ───────────────────────────────────────────────────────────

    describe('tenant CRUD — super_admin full access', () => {
      it('create → list → get → update name → soft-delete', async () => {
        const headers = { Authorization: `Bearer ${superAdminToken}` };

        // Create
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/tenants',
          headers,
          payload: { name: `IntTest Tenant E26 ${RUN_TAG}`, tenant_type: 'external' },
        });
        expect(createRes.statusCode).toBe(201);
        const created = JSON.parse(createRes.body) as { id: string; name: string; active: boolean };
        expect(created.name).toBe('IntTest Tenant E26');
        expect(created.active).toBe(true);

        // List — tenant should appear
        const listRes = await app.inject({ method: 'GET', url: '/api/v1/admin/tenants', headers });
        expect(listRes.statusCode).toBe(200);
        const list = JSON.parse(listRes.body) as Array<{ id: string }>;
        expect(list.some((t) => t.id === created.id)).toBe(true);

        // Get
        const getRes = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${created.id}`,
          headers,
        });
        expect(getRes.statusCode).toBe(200);
        expect(JSON.parse(getRes.body)).toMatchObject({ id: created.id, name: 'IntTest Tenant E26' });

        // Update name
        const putRes = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/tenants/${created.id}`,
          headers,
          payload: { name: `IntTest Tenant E26 Updated ${RUN_TAG}` },
        });
        expect(putRes.statusCode).toBe(200);
        expect(JSON.parse(putRes.body)).toMatchObject({ name: 'IntTest Tenant E26 Updated' });

        // Soft-delete
        const delRes = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/tenants/${created.id}`,
          headers,
        });
        expect(delRes.statusCode).toBe(200);
        expect(JSON.parse(delRes.body)).toMatchObject({ active: false });

        // Already inactive → 400
        const delAgain = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/tenants/${created.id}`,
          headers,
        });
        expect(delAgain.statusCode).toBe(400);

        // Cleanup
        const { getPool } = await import('../db/pool.js');
        await getPool().query(`DELETE FROM tenants WHERE id = $1`, [created.id]);
      });

      it('duplicate tenant name+type → 409', async () => {
        const headers = { Authorization: `Bearer ${superAdminToken}` };
        const payload = { name: 'E26 Dup Tenant', tenant_type: 'external' };
        const first = await app.inject({ method: 'POST', url: '/api/v1/admin/tenants', headers, payload });
        expect(first.statusCode).toBe(201);
        const second = await app.inject({ method: 'POST', url: '/api/v1/admin/tenants', headers, payload });
        expect(second.statusCode).toBe(409);

        const { getPool } = await import('../db/pool.js');
        await getPool().query(`DELETE FROM tenants WHERE name = 'E26 Dup Tenant'`);
      });
    });

    // ── Product registration ──────────────────────────────────────────────────

    describe('product registration + GET — secret exposure rules', () => {
      it('register product → client_secret in 201; absent from GET list and detail', async () => {
        const headers = { Authorization: `Bearer ${superAdminToken}` };
        const { getPool } = await import('../db/pool.js');

        // Create tenant
        const tenantRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/tenants',
          headers,
          payload: { name: `E26 Product Tenant ${RUN_TAG}`, tenant_type: 'external' },
        });
        const tenant = JSON.parse(tenantRes.body) as { id: string };

        // Register product
        const prodRes = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/tenants/${tenant.id}/products`,
          headers,
          payload: { name: `My SDK Product ${RUN_TAG}` },
        });
        expect(prodRes.statusCode).toBe(201);
        const prod = JSON.parse(prodRes.body) as {
          product_id: string;
          client_id: string;
          client_secret: string;
          name: string;
          active: boolean;
        };
        expect(prod.client_secret).toMatch(/^[0-9a-f]{64}$/);
        expect(prod.client_id).toBeTruthy();
        expect(prod.active).toBe(true);

        // GET list — no client_secret
        const listRes = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenant.id}/products`,
          headers,
        });
        expect(listRes.statusCode).toBe(200);
        const list = JSON.parse(listRes.body) as Array<Record<string, unknown>>;
        expect(list.every((p) => !('client_secret' in p))).toBe(true);
        expect(list.some((p) => p['product_id'] === prod.product_id)).toBe(true);

        // GET detail — no client_secret
        const detRes = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/tenants/${tenant.id}/products/${prod.product_id}`,
          headers,
        });
        expect(detRes.statusCode).toBe(200);
        const detail = JSON.parse(detRes.body) as Record<string, unknown>;
        expect('client_secret' in detail).toBe(false);
        expect(detail['client_id']).toBe(prod.client_id);

        // Cleanup — child-first FK order via HUB-1550 helper.
        await cleanupProduct(getPool(), prod.product_id);
        await cleanupTenant(getPool(), tenant.id);
      });
    });

    // ── Credential rotation ───────────────────────────────────────────────────

    describe('credential rotation — old secret invalid, new secret valid', () => {
      it('rotate → old bcrypt mismatch; new secret bcrypt matches stored hash', async () => {
        const headers = { Authorization: `Bearer ${superAdminToken}` };
        const { getPool } = await import('../db/pool.js');

        const tenantRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/tenants',
          headers,
          payload: { name: `E26 Rotation Tenant ${RUN_TAG}`, tenant_type: 'external' },
        });
        const tenant = JSON.parse(tenantRes.body) as { id: string };

        const prodRes = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/tenants/${tenant.id}/products`,
          headers,
          payload: { name: `Rotation Product ${RUN_TAG}` },
        });
        const prod = JSON.parse(prodRes.body) as { product_id: string; client_secret: string };
        const oldSecret = prod.client_secret;

        const rotRes = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/tenants/${tenant.id}/products/${prod.product_id}/rotate-secret`,
          headers,
        });
        expect(rotRes.statusCode).toBe(200);
        const rotated = JSON.parse(rotRes.body) as { client_secret: string; rotated_at: string };
        expect(rotated.client_secret).toMatch(/^[0-9a-f]{64}$/);
        expect(rotated.client_secret).not.toBe(oldSecret);
        expect(rotated.rotated_at).toBeTruthy();

        // Verify new secret matches stored hash; old secret does not
        const { rows } = await getPool().query<{ client_secret_hash: string }>(
          `SELECT pr.client_secret_hash FROM product_registrations pr
             JOIN products p ON p.id = pr.product_id
            WHERE p.id = $1`,
          [prod.product_id],
        );
        expect(await bcrypt.compare(rotated.client_secret, rows[0]!.client_secret_hash)).toBe(true);
        expect(await bcrypt.compare(oldSecret, rows[0]!.client_secret_hash)).toBe(false);

        // Cleanup — child-first FK order via HUB-1550 helper.
        await cleanupProduct(getPool(), prod.product_id);
        await cleanupTenant(getPool(), tenant.id);
      });
    });

    // ── Deactivation cascade ─────────────────────────────────────────────────

    describe('tenant deactivation cascade — products disabled; re-activation does not cascade', () => {
      it('deactivate tenant → all products active=false → re-activate tenant → products still inactive', async () => {
        const headers = { Authorization: `Bearer ${superAdminToken}` };
        const { getPool } = await import('../db/pool.js');

        const tenantRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/tenants',
          headers,
          payload: { name: `E26 Cascade Tenant ${RUN_TAG}`, tenant_type: 'external' },
        });
        const tenant = JSON.parse(tenantRes.body) as { id: string };

        const p1Res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/tenants/${tenant.id}/products`,
          headers,
          payload: { name: `Cascade Product 1 ${RUN_TAG}` },
        });
        const p1 = JSON.parse(p1Res.body) as { product_id: string };

        const delRes = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/tenants/${tenant.id}`,
          headers,
        });
        expect(delRes.statusCode).toBe(200);
        const delBody = JSON.parse(delRes.body) as { products_deactivated: number };
        expect(delBody.products_deactivated).toBe(1);

        // Product is now inactive in DB
        const { rows } = await getPool().query<{ active: boolean }>(
          `SELECT active FROM products WHERE id = $1`,
          [p1.product_id],
        );
        expect(rows[0]!.active).toBe(false);

        // Re-activate tenant
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/tenants/${tenant.id}`,
          headers,
          payload: { active: true },
        });

        // Product still inactive
        const { rows: rows2 } = await getPool().query<{ active: boolean }>(
          `SELECT active FROM products WHERE id = $1`,
          [p1.product_id],
        );
        expect(rows2[0]!.active).toBe(false);

        // Cleanup — child-first FK order via HUB-1550 helper.
        await cleanupProduct(getPool(), p1.product_id);
        await cleanupTenant(getPool(), tenant.id);
      });
    });
  },
);
