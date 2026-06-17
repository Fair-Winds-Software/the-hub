// Authorized by HUB-1513 — E29 portal integration tests; gated behind RUN_INTEGRATION=1

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { join } from 'path';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'E29 Customer Self-Serve Portal Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let portalToken: string;
    let tenantId: string;
    let productId: string;
    let tenantUserId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      const hash = await bcrypt.hash('PortalPass!77', 12);

      // Seed tenant + product
      const { rows: tRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ('E29 Portal Tenant', 'external', true)
         RETURNING id`,
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, 'E29 Portal Product', 'e29-portal-product', true)
         RETURNING id`,
        [tenantId],
      );
      productId = pRows[0]!.id;

      // Seed tenant_user
      const { rows: uRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenant_users (tenant_id, email, password_hash, active)
         VALUES ($1, 'test-portal@e29.test', $2, true)
         RETURNING id`,
        [tenantId, hash],
      );
      tenantUserId = uRows[0]!.id;

      // Login to get portal token
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/portal/auth/login',
        payload: { email: 'test-portal@e29.test', password: 'PortalPass!77', tenant_id: tenantId },
      });
      portalToken = (JSON.parse(loginRes.body) as { accessToken: string }).accessToken;
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      await pool.query(`DELETE FROM tenant_users WHERE id = $1`, [tenantUserId]);
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await app.close();
    });

    // ── TODO-D-DEF-007 comment presence ──────────────────────────────────────

    it('TODO-D-DEF-007 comment is present in portal route file', () => {
      const routeFile = readFileSync(
        join(process.cwd(), 'src', 'routes', 'portal', 'index.ts'),
        'utf-8',
      );
      expect(routeFile).toContain('TODO-D-DEF-007');
    });

    // ── Auth ──────────────────────────────────────────────────────────────────

    describe('POST /api/v1/portal/auth/login', () => {
      it('returns 200 + accessToken on valid credentials', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/portal/auth/login',
          payload: { email: 'test-portal@e29.test', password: 'PortalPass!77', tenant_id: tenantId },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { accessToken: string; expiresIn: number };
        expect(body.accessToken).toBeTruthy();
        expect(body.expiresIn).toBe(3600);
      });

      it('returns 401 on wrong password', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/portal/auth/login',
          payload: { email: 'test-portal@e29.test', password: 'WRONG', tenant_id: tenantId },
        });
        expect(res.statusCode).toBe(401);
      });

      it('returns 401 on wrong tenant_id', async () => {
        const fakeId = '00000000-0000-0000-0000-000000000001';
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/portal/auth/login',
          payload: { email: 'test-portal@e29.test', password: 'PortalPass!77', tenant_id: fakeId },
        });
        expect(res.statusCode).toBe(401);
      });
    });

    // ── JWT enforcement ───────────────────────────────────────────────────────

    describe('JWT enforcement on protected routes', () => {
      it('GET /portal/profile with no JWT returns 401', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/portal/profile' });
        expect(res.statusCode).toBe(401);
      });

      it('GET /portal/profile with malformed token returns 401', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/portal/profile',
          headers: { Authorization: 'Bearer not.a.valid.jwt' },
        });
        expect(res.statusCode).toBe(401);
      });
    });

    // ── Profile ───────────────────────────────────────────────────────────────

    describe('GET /api/v1/portal/profile', () => {
      it('returns tenant + products shape', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/portal/profile',
          headers: { Authorization: `Bearer ${portalToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          tenant: { id: string; name: string };
          products: Array<{ id: string; name: string; slug: string }>;
        };
        expect(body.tenant.id).toBe(tenantId);
        expect(body.tenant.name).toBe('E29 Portal Tenant');
        expect(Array.isArray(body.products)).toBe(true);
        expect(body.products.some((p) => p.id === productId)).toBe(true);
      });
    });

    // ── Notifications ─────────────────────────────────────────────────────────

    describe('GET /api/v1/portal/notifications', () => {
      it('returns paginated shape', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/portal/notifications',
          headers: { Authorization: `Bearer ${portalToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          notifications: unknown[];
          total: number;
          limit: number;
          offset: number;
        };
        expect(Array.isArray(body.notifications)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(body.limit).toBe(20);
        expect(body.offset).toBe(0);
      });
    });

    // ── Invoice list D-005 enforcement ────────────────────────────────────────

    describe('GET /api/v1/portal/invoices — D-005', () => {
      it('returns 400 when productId is absent', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/portal/invoices',
          headers: { Authorization: `Bearer ${portalToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns empty array when productId provided and no invoices', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/portal/invoices?productId=${productId}`,
          headers: { Authorization: `Bearer ${portalToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual([]);
      });
    });

    // ── Invoice detail — unknown ID ───────────────────────────────────────────

    describe('GET /api/v1/portal/invoices/:invoiceId', () => {
      it('returns 404 for unknown invoiceId', async () => {
        const fakeId = '00000000-0000-0000-0000-000000000099';
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/portal/invoices/${fakeId}`,
          headers: { Authorization: `Bearer ${portalToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── Usage — unknown product ───────────────────────────────────────────────

    describe('GET /api/v1/portal/usage/:productId', () => {
      it('returns 200 empty array for own product with no cost data', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/portal/usage/${productId}`,
          headers: { Authorization: `Bearer ${portalToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(JSON.parse(res.body))).toBe(true);
      });

      it('returns 404 for product not belonging to tenant', async () => {
        const fakeId = '00000000-0000-0000-0000-000000000099';
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/portal/usage/${fakeId}`,
          headers: { Authorization: `Bearer ${portalToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });
  },
);
