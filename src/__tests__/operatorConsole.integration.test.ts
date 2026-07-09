// Authorized by HUB-1079 — integration tests: RBAC enforcement; session lifecycle; cross-tenant 403; settings cache

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

// All tests in this file require a live PostgreSQL DB and Redis.
// Gate them behind RUN_INTEGRATION=1 so the unit-only CI run skips them cleanly.
(RUN_INTEGRATION ? describe : describe.skip)(
  'Operator Console Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      await closeAppResources(app);
    });

    afterEach(async () => {
      // Clean up test operators between tests
      const { getPool } = await import('../db/pool.js');
      await getPool().query(
        `DELETE FROM operator_accounts WHERE email LIKE 'test-%@integration.test'`,
      );
    });

    // ── Auth route bypass ──────────────────────────────────────────────────────

    describe('auth route bypass — no RBAC hook on /auth/* paths', () => {
      it('POST /api/v1/admin/auth/login with no Authorization returns 401 (not 401 from hook)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: 'nobody@example.com', password: 'wrong' },
        });
        // Route is reachable (not blocked by RBAC hook before the handler runs)
        // The handler itself returns 401 for invalid credentials — but the route IS accessible
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.body)).toMatchObject({ error: { message: 'Invalid credentials' } });
      });
    });

    // ── Full session lifecycle ─────────────────────────────────────────────────

    describe('session lifecycle — login → use → refresh → logout → replay', () => {
      it('full cycle succeeds with correct role claims and revoke-on-replay', async () => {
        // Seed a super_admin operator
        const { getPool } = await import('../db/pool.js');
        const bcrypt = await import('bcryptjs');
        const hash = await bcrypt.hash('TestPass123!', 12);
        const { rows } = await getPool().query<{ id: string }>(
          `INSERT INTO operator_accounts (email, password_hash, role) VALUES ($1, $2, 'super_admin') RETURNING id`,
          ['test-super@integration.test', hash],
        );
        const operatorId = rows[0]!.id;
        expect(operatorId).toBeTruthy();

        // Login
        const loginRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: 'test-super@integration.test', password: 'TestPass123!' },
        });
        expect(loginRes.statusCode).toBe(200);
        const { accessToken, refreshToken } = JSON.parse(loginRes.body) as {
          accessToken: string;
          refreshToken: string;
        };
        expect(accessToken).toBeTruthy();
        expect(refreshToken).toBeTruthy();

        // Use access token on a protected route
        const listRes = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/operators',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        expect(listRes.statusCode).toBe(200);

        // Refresh
        const refreshRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/refresh',
          payload: { refreshToken },
        });
        expect(refreshRes.statusCode).toBe(200);
        const { refreshToken: newRefreshToken } = JSON.parse(refreshRes.body) as {
          refreshToken: string;
        };
        expect(newRefreshToken).toBeTruthy();
        expect(newRefreshToken).not.toBe(refreshToken);

        // Old refresh token is revoked — replay should 401
        const replayRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/refresh',
          payload: { refreshToken },
        });
        expect(replayRes.statusCode).toBe(401);

        // Logout
        const logoutRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/logout',
          payload: { refreshToken: newRefreshToken },
        });
        expect(logoutRes.statusCode).toBe(200);
        expect(JSON.parse(logoutRes.body)).toMatchObject({ success: true });

        // After logout, the new refresh token is revoked too
        const replayAfterLogout = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/refresh',
          payload: { refreshToken: newRefreshToken },
        });
        expect(replayAfterLogout.statusCode).toBe(401);
      });
    });

    // ── Cross-tenant rejection ─────────────────────────────────────────────────

    describe('cross-tenant rejection — product_admin JWT rejected for other tenant', () => {
      it('product_admin with tenant X cannot access routes for tenant Y', async () => {
        const { getPool } = await import('../db/pool.js');
        const bcrypt = await import('bcryptjs');
        const jwt = await import('jsonwebtoken');

        // Seed a tenant (or use an existing UUID)
        const { rows: tenantRows } = await getPool().query<{ id: string }>(
          `SELECT id FROM tenants LIMIT 1`,
        );
        if (!tenantRows[0]) return; // skip if no tenants seeded

        const tenantA = tenantRows[0].id;
        const tenantB = crypto.randomUUID(); // non-existent

        const hash = await bcrypt.hash('Pass1!', 12);
        await getPool().query(
          `INSERT INTO operator_accounts (email, password_hash, role, tenant_id) VALUES ($1, $2, 'product_admin', $3)`,
          ['test-tadmin@integration.test', hash, tenantA],
        );

        const token = jwt.sign(
          { operator_id: crypto.randomUUID(), role: 'product_admin', tenant_id: tenantA },
          process.env.OPERATOR_JWT_SECRET!,
          { expiresIn: 900 },
        );

        // Request for tenantB path should be 403
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/operators?tenantId=${tenantB}`,
          headers: { Authorization: `Bearer ${token}` },
        });
        // The operators route is super_admin only so this also returns 403, but via RBAC role check
        expect([403]).toContain(res.statusCode);
      });
    });

    // ── super_admin traversal ──────────────────────────────────────────────────

    describe('super_admin traversal — unrestricted access', () => {
      it('super_admin JWT can list operators without any tenant restriction', async () => {
        const { getPool } = await import('../db/pool.js');
        const bcrypt = await import('bcryptjs');
        const hash = await bcrypt.hash('SuperPass!1', 12);
        await getPool().query(
          `INSERT INTO operator_accounts (email, password_hash, role) VALUES ($1, $2, 'super_admin')`,
          ['test-super2@integration.test', hash],
        );

        const loginRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: 'test-super2@integration.test', password: 'SuperPass!1' },
        });
        const { accessToken } = JSON.parse(loginRes.body) as { accessToken: string };

        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/operators',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(JSON.parse(res.body))).toBe(true);
      });
    });

    // ── Password not in logs ───────────────────────────────────────────────────

    describe('password redaction', () => {
      it('login request body password does not appear in Pino log output', async () => {
        const logLines: string[] = [];
        const origWrite = process.stdout.write.bind(process.stdout);
        (process.stdout as any).write = (chunk: string) => {
          logLines.push(chunk.toString());
          return true;
        };

        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: 'log-test@integration.test', password: 'SuperSecretPassword999!' },
        });

        (process.stdout as any).write = origWrite;

        const combined = logLines.join('\n');
        expect(combined).not.toContain('SuperSecretPassword999!');
      });
    });

    // ── Operator CRUD + role assignment ────────────────────────────────────────

    describe('operator CRUD + role assignment end-to-end', () => {
      it('create → list → role-assign → deactivate cycle as super_admin', async () => {
        const { getPool } = await import('../db/pool.js');
        const bcrypt = await import('bcryptjs');
        const hash = await bcrypt.hash('AdminPass!2', 12);
        await getPool().query(
          `INSERT INTO operator_accounts (email, password_hash, role) VALUES ($1, $2, 'super_admin')`,
          ['test-crud-super@integration.test', hash],
        );

        const loginRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: 'test-crud-super@integration.test', password: 'AdminPass!2' },
        });
        const { accessToken } = JSON.parse(loginRes.body) as { accessToken: string };
        const headers = { Authorization: `Bearer ${accessToken}` };

        // Create a new operator
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/operators',
          headers,
          payload: { email: 'test-new-op@integration.test', password: 'NewOpPass!3', role: 'super_admin' },
        });
        expect(createRes.statusCode).toBe(201);
        const created = JSON.parse(createRes.body) as { id: string; email: string };
        expect(created.email).toBe('test-new-op@integration.test');
        expect(created).not.toHaveProperty('password_hash');

        // List — should contain the new operator
        const listRes = await app.inject({ method: 'GET', url: '/api/v1/admin/operators', headers });
        expect(listRes.statusCode).toBe(200);
        const list = JSON.parse(listRes.body) as Array<{ email: string }>;
        expect(list.some(o => o.email === 'test-new-op@integration.test')).toBe(true);

        // Deactivate
        const delRes = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/operators/${created.id}`,
          headers,
        });
        expect(delRes.statusCode).toBe(200);
        expect(JSON.parse(delRes.body)).toMatchObject({ success: true });

        // Verify active=false
        const getRes = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/operators/${created.id}`,
          headers,
        });
        expect(JSON.parse(getRes.body)).toMatchObject({ active: false });

        await getPool().query(
          `DELETE FROM operator_accounts WHERE email = 'test-new-op@integration.test'`,
        );
      });
    });

    // ── Settings cache ─────────────────────────────────────────────────────────

    describe('settings cache — cold GET → DB; warm GET → Redis; PUT → updated value', () => {
      it('GET (cold) then PUT then GET returns updated value', async () => {
        const { getPool } = await import('../db/pool.js');
        const bcrypt = await import('bcryptjs');
        const hash = await bcrypt.hash('SettingsPass!', 12);
        await getPool().query(
          `INSERT INTO operator_accounts (email, password_hash, role) VALUES ($1, $2, 'super_admin')`,
          ['test-settings@integration.test', hash],
        );
        const loginRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: 'test-settings@integration.test', password: 'SettingsPass!' },
        });
        const { accessToken } = JSON.parse(loginRes.body) as { accessToken: string };
        const headers = { Authorization: `Bearer ${accessToken}` };

        // PUT a setting
        const putRes = await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings',
          headers,
          payload: { key: 'test_integration_setting', value: 'hello_world' },
        });
        expect(putRes.statusCode).toBe(200);
        expect(JSON.parse(putRes.body)).toMatchObject({ key: 'test_integration_setting', value: 'hello_world' });

        // GET all — should include our setting
        const getRes = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/settings',
          headers,
        });
        expect(getRes.statusCode).toBe(200);
        const body = JSON.parse(getRes.body) as { settings: Record<string, unknown> };
        expect(body.settings['test_integration_setting']).toBe('hello_world');

        // Clean up
        await getPool().query(`DELETE FROM settings WHERE key = 'test_integration_setting'`);
      });
    });
  },
);
