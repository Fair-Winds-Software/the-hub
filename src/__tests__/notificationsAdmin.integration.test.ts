// Authorized by HUB-1505 — E28 integration tests; gated behind RUN_INTEGRATION=1

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'E28 Notifications, Alerts & Hooks Admin Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let superAdminToken: string;
    let tenantAdminToken: string;
    let foreignAdminToken: string;
    let tenantId: string;
    let productId: string;
    let foreignTenantId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      const hash = await bcrypt.hash('IntPass!99', 12);

      // Seed main tenant + product
      const { rows: tRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ('E28 Test Tenant', 'external', true)
         RETURNING id`,
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, 'E28 Product', 'e28-product-test', true)
         RETURNING id`,
        [tenantId],
      );
      productId = pRows[0]!.id;

      // Seed foreign tenant (for RBAC isolation tests)
      const { rows: ftRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ('E28 Foreign Tenant', 'external', true)
         RETURNING id`,
      );
      foreignTenantId = ftRows[0]!.id;

      // Seed super_admin
      await pool.query(
        `INSERT INTO operator_accounts (email, password_hash, role)
         VALUES ('test-e28-super@integration.test', $1, 'super_admin')
         ON CONFLICT DO NOTHING`,
        [hash],
      );

      // Seed product_admin scoped to main tenant
      await pool.query(
        `INSERT INTO operator_accounts (email, password_hash, role, tenant_id)
         VALUES ('test-e28-admin@integration.test', $1, 'product_admin', $2)
         ON CONFLICT DO NOTHING`,
        [hash, tenantId],
      );

      // Seed product_admin scoped to foreign tenant
      await pool.query(
        `INSERT INTO operator_accounts (email, password_hash, role, tenant_id)
         VALUES ('test-e28-foreign@integration.test', $1, 'product_admin', $2)
         ON CONFLICT DO NOTHING`,
        [hash, foreignTenantId],
      );

      // Login super_admin
      const superRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'test-e28-super@integration.test', password: 'IntPass!99' },
      });
      superAdminToken = (JSON.parse(superRes.body) as { accessToken: string }).accessToken;

      // Login product_admin
      const taRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'test-e28-admin@integration.test', password: 'IntPass!99' },
      });
      tenantAdminToken = (JSON.parse(taRes.body) as { accessToken: string }).accessToken;

      // Login foreign product_admin
      const ftaRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        payload: { email: 'test-e28-foreign@integration.test', password: 'IntPass!99' },
      });
      foreignAdminToken = (JSON.parse(ftaRes.body) as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      await pool.query(`DELETE FROM notification_channels WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM escalation_rules WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM workflow_hooks WHERE tenant_id IN ($1, $2)`, [tenantId, foreignTenantId]);
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [tenantId, foreignTenantId]);
      await pool.query(
        `DELETE FROM operator_accounts WHERE email LIKE 'test-e28-%@integration.test'`,
      );
      await app.close();
    });

    // ── Alert summary ────────────────────────────────────────────────────────

    describe('GET alert summary', () => {
      it('returns counts and recent_unacknowledged shape for super_admin', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/alerts/summary/${tenantId}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { counts: { info: number; warning: number; critical: number }; recent_unacknowledged: unknown[] };
        expect(body).toMatchObject({ counts: { info: expect.any(Number), warning: expect.any(Number), critical: expect.any(Number) } });
        expect(Array.isArray(body.recent_unacknowledged)).toBe(true);
      });

      it('product_admin can read own tenant summary', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/alerts/summary/${tenantId}`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
        });
        expect(res.statusCode).toBe(200);
      });

      it('foreign product_admin receives 403 on summary', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/alerts/summary/${tenantId}`,
          headers: { Authorization: `Bearer ${foreignAdminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });
    });

    // ── RBAC: alert ack/resolve ──────────────────────────────────────────────

    describe('RBAC — foreign product_admin receives 403 on alert routes', () => {
      const fakeAlertId = '00000000-0000-0000-0000-000000000099';

      it('POST acknowledge → 403 for foreign product_admin', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/alerts/${tenantId}/${fakeAlertId}/acknowledge`,
          headers: { Authorization: `Bearer ${foreignAdminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });

      it('POST resolve → 403 for foreign product_admin', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/alerts/${tenantId}/${fakeAlertId}/resolve`,
          headers: { Authorization: `Bearer ${foreignAdminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });

      it('GET alert list → 403 for foreign product_admin', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/alerts/${tenantId}`,
          headers: { Authorization: `Bearer ${foreignAdminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });
    });

    // ── Alert list (own tenant) ──────────────────────────────────────────────

    describe('GET admin alert list', () => {
      it('returns paginated shape for own tenant', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/alerts/${tenantId}`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { alerts: unknown[]; total: number; limit: number; offset: number };
        expect(Array.isArray(body.alerts)).toBe(true);
        expect(typeof body.total).toBe('number');
      });
    });

    // ── Notification channel upsert ──────────────────────────────────────────

    describe('POST notification channel — upsert semantics', () => {
      it('returns 201 on first insert', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/notifications/${tenantId}/${productId}/channels`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
          payload: { channel_type: 'email', config: { to: 'test@example.com' }, enabled: true },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { id: string; action: string };
        expect(body.action).toBe('created');
        expect(body.id).toBeTruthy();
      });

      it('returns 200 on conflict (same channel_type)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/notifications/${tenantId}/${productId}/channels`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
          payload: { channel_type: 'email', config: { to: 'updated@example.com' }, enabled: true },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { action: string };
        expect(body.action).toBe('updated');
      });

      it('foreign product_admin receives 403', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/notifications/${tenantId}/${productId}/channels`,
          headers: { Authorization: `Bearer ${foreignAdminToken}` },
          payload: { channel_type: 'in_app', config: {}, enabled: true },
        });
        expect(res.statusCode).toBe(403);
      });
    });

    // ── Escalation rule tier cap ─────────────────────────────────────────────

    describe('Escalation rule — 2-tier cap enforcement', () => {
      const alertType = 'e28-test-alert';

      afterAll(async () => {
        const { getPool } = await import('../db/pool.js');
        await getPool().query(
          `DELETE FROM escalation_rules WHERE tenant_id = $1 AND alert_type = $2`,
          [tenantId, alertType],
        );
      });

      it('POST with tier=3 returns 400', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/escalation/${tenantId}/${productId}/rules`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
          payload: {
            tier: 3,
            threshold_minutes: 15,
            alert_type: alertType,
            escalation_contacts: [{ type: 'email', value: 'oncall@example.com' }],
          },
        });
        expect(res.statusCode).toBe(400);
      });

      it('creates tier 1 rule successfully', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/escalation/${tenantId}/${productId}/rules`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
          payload: {
            tier: 1,
            threshold_minutes: 15,
            alert_type: alertType,
            escalation_contacts: [{ type: 'email', value: 'oncall@example.com' }],
          },
        });
        expect(res.statusCode).toBe(201);
      });

      it('creates tier 2 rule successfully', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/escalation/${tenantId}/${productId}/rules`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
          payload: {
            tier: 2,
            threshold_minutes: 30,
            alert_type: alertType,
            escalation_contacts: [{ type: 'email', value: 'manager@example.com' }],
          },
        });
        expect(res.statusCode).toBe(201);
      });

      it('3rd rule returns 409 (cap reached)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/escalation/${tenantId}/${productId}/rules`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
          payload: {
            tier: 1,
            threshold_minutes: 5,
            alert_type: alertType,
            escalation_contacts: [{ type: 'email', value: 'extra@example.com' }],
          },
        });
        expect(res.statusCode).toBe(409);
      });
    });

    // ── Workflow hook hmac_secret masking ────────────────────────────────────

    describe('Workflow hook — hmac_secret masking end-to-end', () => {
      let hookId: string;

      it('POST hook registers and masks secret in response', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/hooks/${tenantId}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
          payload: {
            trigger_event_type: 'license.suspended',
            action_config: {
              url: 'https://example.com/webhook',
              hmac_secret: 'super-secret-value-e28',
            },
            enabled: true,
          },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { id: string; action_config: { hmac_secret: string } };
        hookId = body.id;
        expect(body.action_config.hmac_secret).toBe('***');
      });

      it('GET list returns hmac_secret masked as ***', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/hooks/${tenantId}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(200);
        const hooks = JSON.parse(res.body) as Array<{ action_config: { hmac_secret: string } }>;
        for (const hook of hooks) {
          expect(hook.action_config.hmac_secret).toBe('***');
        }
      });

      it('foreign product_admin receives 403 on GET hooks', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/hooks/${tenantId}`,
          headers: { Authorization: `Bearer ${foreignAdminToken}` },
        });
        expect(res.statusCode).toBe(403);
      });

      it('DELETE hook succeeds', async () => {
        if (!hookId) return;
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/hooks/${tenantId}/${hookId}`,
          headers: { Authorization: `Bearer ${superAdminToken}` },
        });
        expect(res.statusCode).toBe(204);
      });
    });
  },
);
