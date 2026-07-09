// Authorized by HUB-1759 (E-V2-PP-4 S10, HUB-1728, HUB-1701) — end-to-end integration
// test for the grandfather + upgrade-suggestion API surface, complementing the service-
// level tests in grandfatherService.integration.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const CONNECTION_STRING = process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1759-${Date.now()}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1759 (E-V2-PP-4 S10): grandfather + upgrade-suggestion API',
  () => {
    let app: FastifyInstance;
    let client: Client;
    let superAdminToken: string;
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
      superAdminToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-00000000fffd', role: 'super_admin', tenant_id: null },
        secret, { expiresIn: '1h' },
      );
    });

    afterAll(async () => {
      await client.query(`DELETE FROM upgrade_suggestions WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM pricing_grandfathers WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await client.end();
      await closeAppResources(app);
    });

    const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

    it('POST /admin/tenants/:id/grandfathers creates a grandfather (S7 route)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/tenants/${tenantId}/grandfathers`,
        headers: auth(),
        payload: {
          product_id: productId,
          policy_type: '12_month_lock',
          delta_cents: -50000,
          effective_from: '2026-06-01',
          expires_at: '2027-06-01',
          terms: 'Locked pricing for 12 months per Q4 2025 contract negotiation.',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { id: string; delta_cents: number };
      expect(body.delta_cents).toBe(-50000);
    });

    it('GET /admin/tenants/:id/grandfathers lists the row', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/tenants/${tenantId}/grandfathers`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: Array<unknown>; total: number };
      expect(body.total).toBe(1);
    });

    it('POST /grandfathers rejects delta_cents=0 with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/tenants/${tenantId}/grandfathers`,
        headers: auth(),
        payload: {
          product_id: productId,
          policy_type: 'custom',
          delta_cents: 0,
          effective_from: '2026-06-01',
          expires_at: '2027-06-01',
          terms: 'This test payload has enough characters for terms.',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /grandfathers rejects short terms with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/tenants/${tenantId}/grandfathers`,
        headers: auth(),
        payload: {
          product_id: productId,
          policy_type: 'custom',
          delta_cents: -100,
          effective_from: '2026-06-01',
          expires_at: '2027-06-01',
          terms: 'short',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('GET /tenants/:t/products/:p/upgrade-suggestion returns null when none', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${tenantId}/products/${productId}/upgrade-suggestion`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { suggestion: unknown };
      expect(body.suggestion).toBeNull();
    });

    it('POST /upgrade-suggestion/dismiss returns 404 when no active suggestion', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/products/${productId}/upgrade-suggestion/dismiss`,
        headers: auth(),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it('dismiss flow: insert suggestion → dismiss returns cooldown → get returns null', async () => {
      // Seed via direct SQL.
      await client.query(
        `INSERT INTO upgrade_suggestions
           (tenant_id, product_id, suggested_tier_index, based_on_period_from, based_on_period_to, projected_savings_cents)
         VALUES ($1, $2, 1, '2026-04-01', '2026-07-01', 50000)`,
        [tenantId, productId],
      );
      const dismiss = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/products/${productId}/upgrade-suggestion/dismiss`,
        headers: auth(),
        payload: {},
      });
      expect(dismiss.statusCode).toBe(200);
      const dbody = JSON.parse(dismiss.body) as { dismissed: boolean; cooldown_until: string };
      expect(dbody.dismissed).toBe(true);
      expect(dbody.cooldown_until).toBeTruthy();

      const get = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${tenantId}/products/${productId}/upgrade-suggestion`,
        headers: auth(),
      });
      const gbody = JSON.parse(get.body) as { suggestion: unknown };
      expect(gbody.suggestion).toBeNull();
    });

    it('DELETE /grandfathers/:id archives (sets expires_at = today)', async () => {
      // Fetch the grandfather we created.
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/tenants/${tenantId}/grandfathers`,
        headers: auth(),
      });
      const first = (JSON.parse(list.body) as { data: Array<{ id: string }> }).data[0]!;

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/tenants/${tenantId}/grandfathers/${first.id}`,
        headers: auth(),
      });
      expect(del.statusCode).toBe(200);
      const body = JSON.parse(del.body) as { expires_at: string };
      const expDate = new Date(body.expires_at);
      const today = new Date();
      expect(expDate.toISOString().slice(0, 10)).toBe(today.toISOString().slice(0, 10));

      // Second delete is 404 (already archived).
      const del2 = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/tenants/${tenantId}/grandfathers/${first.id}`,
        headers: auth(),
      });
      expect(del2.statusCode).toBe(404);
    });
  },
);
