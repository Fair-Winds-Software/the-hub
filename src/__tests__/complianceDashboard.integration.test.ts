// Authorized by HUB-1090 — compliance dashboard integration test suite: API contracts, RAG logic,
//   TSC grouping, trend reconstruction, access control; gated behind RUN_INTEGRATION=1

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
// HUB-1771 Phase 4: RUN_TAG suffix on fixture names to avoid UNIQUE collisions
const RUN_TAG = Date.now().toString();
const DASH_CONTROL_KEY = `CC-DASH-${RUN_TAG}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'Compliance Dashboard Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let operatorToken: string;
    let tenantAdminToken: string;
    let tenantId: string;
    let otherTenantId: string;
    let productId: string;
    let otherProductId: string;
    let controlId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const { getPool } = await import('../db/pool.js');
      const pool = getPool();

      // Tenant + product for primary operator
      const { rows: tRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ($1, 'external', true)
         RETURNING id`,
        [`Dashboard Test Tenant ${RUN_TAG}`],
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, `Dashboard Product ${RUN_TAG}`, `dash-product-${RUN_TAG}`],
      );
      productId = pRows[0]!.id;

      // Second tenant + product (for access control tests)
      const { rows: t2Rows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ($1, 'external', true)
         RETURNING id`,
        [`Dashboard Other Tenant ${RUN_TAG}`],
      );
      otherTenantId = t2Rows[0]!.id;

      const { rows: p2Rows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [otherTenantId, `Other Product ${RUN_TAG}`, `other-dash-product-${RUN_TAG}`],
      );
      otherProductId = p2Rows[0]!.id;

      // Create a control + register product + bind
      const jwt = await import('jsonwebtoken');
      const secret = process.env.OPERATOR_JWT_SECRET ?? 'test-operator-secret';
      operatorToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-000000000002', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );
      tenantAdminToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-000000000003', role: 'product_admin', tenant_id: tenantId },
        secret,
        { expiresIn: '1h' },
      );

      // Create control
      const ctrlRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/compliance/controls',
        headers: { Authorization: `Bearer ${operatorToken}` },
        payload: {
          control_id: DASH_CONTROL_KEY,
          name: 'Dashboard Test Control',
          tsc_category: 'CC6',
          control_class: 'automated',
          eval_cadence: 'daily',
        },
      });
      controlId = (JSON.parse(ctrlRes.body) as { id: string }).id;

      // Register product + bind control
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/compliance/products/${productId}/register`,
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/compliance/products/${productId}/bindings`,
        headers: { Authorization: `Bearer ${operatorToken}` },
        payload: { control_id: controlId },
      });

      // Run evaluation (produces verdicts + posture scores)
      const { runComplianceEvaluation } = await import('../services/complianceEvaluationService.js');
      await runComplianceEvaluation();
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      // Clean up in FK order
      await pool.query(`DELETE FROM compliance_posture_scores WHERE product_id IN ($1, $2)`, [productId, otherProductId]);
      await pool.query(`DELETE FROM compliance_verdict_history WHERE product_id IN ($1, $2)`, [productId, otherProductId]);
      await pool.query(`DELETE FROM compliance_current_verdicts WHERE product_id IN ($1, $2)`, [productId, otherProductId]);
      await pool.query(`DELETE FROM compliance_signal_evidence WHERE product_id IN ($1, $2)`, [productId, otherProductId]);
      await pool.query(`DELETE FROM product_control_bindings WHERE product_id IN ($1, $2)`, [productId, otherProductId]);
      await pool.query(`DELETE FROM compliance_product_registrations WHERE product_id IN ($1, $2)`, [productId, otherProductId]);
      if (controlId) {
        await pool.query(`DELETE FROM compliance_controls WHERE id = $1`, [controlId]);
      }
      await pool.query(
        `DELETE FROM compliance_evaluation_runs WHERE started_at > NOW() - INTERVAL '1 hour'`,
      );
      await pool.query(`DELETE FROM products WHERE id IN ($1, $2)`, [productId, otherProductId]);
      await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [tenantId, otherTenantId]);
      await closeAppResources(app);
    });

    // ── 1. Overview endpoint — unauthenticated ─────────────────────────────────

    describe('GET /api/v1/admin/compliance/dashboard/overview — access control', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/dashboard/overview',
        });
        expect(res.statusCode).toBe(401);
      });
    });

    // ── 2. Overview endpoint — super_admin sees all products ──────────────────

    describe('GET /api/v1/admin/compliance/dashboard/overview — super_admin', () => {
      it('returns 200 with overall_score_pct and products array', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/dashboard/overview',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          overall_score_pct: number;
          rag_status: string;
          total_products: number;
          products: Array<{ product_id: string; categories: unknown[] }>;
        };
        expect(typeof body.overall_score_pct).toBe('number');
        expect(['green', 'amber', 'red']).toContain(body.rag_status);
        expect(body.total_products).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(body.products)).toBe(true);
        const found = body.products.find((p) => p.product_id === productId);
        expect(found).toBeDefined();
        expect(Array.isArray(found?.categories)).toBe(true);
      });

      it('each product includes rag_status', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/dashboard/overview',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        const body = JSON.parse(res.body) as {
          products: Array<{ rag_status: string; categories: Array<{ rag_status: string }> }>;
        };
        for (const p of body.products) {
          expect(['green', 'amber', 'red']).toContain(p.rag_status);
          for (const c of p.categories) {
            expect(['green', 'amber', 'red']).toContain(c.rag_status);
          }
        }
      });
    });

    // ── 3. Overview endpoint — product_admin sees only own tenant ──────────────

    describe('GET /api/v1/admin/compliance/dashboard/overview — product_admin scope', () => {
      it('product_admin only receives products from own tenant', async () => {
        // HUB-1772: operatorRbacHook currently requires an explicit tenant_id
        // param for product_admin callers even though this route self-scopes
        // via `op.tenant_id` inside the handler. Passing tenant_id here as a
        // workaround; hook fix will let this route work without the redundant
        // param and the query string can be removed.
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/overview?tenant_id=${tenantId}`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          products: Array<{ product_id: string }>;
        };
        for (const p of body.products) {
          expect(p.product_id).not.toBe(otherProductId);
        }
        const found = body.products.find((p) => p.product_id === productId);
        expect(found).toBeDefined();
      });
    });

    // ── 4. Product detail endpoint — contract ─────────────────────────────────

    describe('GET /api/v1/admin/compliance/dashboard/products/:productId', () => {
      it('returns 200 with product detail including categories and controls', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          product_id: string;
          product_name: string;
          overall_score_pct: number;
          rag_status: string;
          categories: Array<{
            tsc_category: string;
            score_pct: number;
            rag_status: string;
            controls: Array<{ control_key: string; verdict: string }>;
          }>;
        };
        expect(body.product_id).toBe(productId);
        expect(typeof body.product_name).toBe('string');
        expect(typeof body.overall_score_pct).toBe('number');
        expect(['green', 'amber', 'red']).toContain(body.rag_status);
        expect(Array.isArray(body.categories)).toBe(true);
        const cc6 = body.categories.find((c) => c.tsc_category === 'CC6');
        expect(cc6).toBeDefined();
        expect(Array.isArray(cc6?.controls)).toBe(true);
        const ctrl = cc6?.controls.find((c) => c.control_key === DASH_CONTROL_KEY);
        expect(ctrl).toBeDefined();
      });

      it('returns 404 for non-existent product', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/dashboard/products/00000000-0000-0000-0000-000000000099',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(404);
      });

      it('returns 403 when product_admin accesses another tenant product', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${otherProductId}`,
          headers: { Authorization: `Bearer ${tenantAdminToken}` },
        });
        // otherProductId is not registered for compliance → 404 from assertProductAccess
        expect([403, 404]).toContain(res.statusCode);
      });

      it('returns 400 for invalid UUID', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/dashboard/products/not-a-uuid',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });
    });

    // ── 5. Trend endpoint — valid windows ─────────────────────────────────────

    describe('GET /api/v1/admin/compliance/dashboard/products/:productId/trend', () => {
      it('returns 200 with datapoints array for window=30 (default)', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}/trend`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          product_id: string;
          window: number;
          datapoints: Array<{ date: string; score_pct: number; rag_status: string }>;
        };
        expect(body.product_id).toBe(productId);
        expect(body.window).toBe(30);
        expect(Array.isArray(body.datapoints)).toBe(true);
        // At least 1 datapoint from the evaluation run done in beforeAll
        expect(body.datapoints.length).toBeGreaterThanOrEqual(1);
        for (const dp of body.datapoints) {
          expect(dp.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(typeof dp.score_pct).toBe('number');
          expect(['green', 'amber', 'red']).toContain(dp.rag_status);
        }
      });

      it('window=60 returns a valid response', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}/trend?window=60`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { window: number };
        expect(body.window).toBe(60);
      });

      it('window=90 returns a valid response', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}/trend?window=90`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { window: number };
        expect(body.window).toBe(90);
      });
    });

    // ── 6. Trend endpoint — invalid window ────────────────────────────────────

    describe('GET /trend — invalid window values', () => {
      it('returns 400 for window=45', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}/trend?window=45`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 for window=abc', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}/trend?window=abc`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });
    });

    // ── 7. RAG status boundary verification ───────────────────────────────────

    describe('RAG status in API responses', () => {
      it('overview rag_status is one of green/amber/red', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/dashboard/overview',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        const body = JSON.parse(res.body) as { rag_status: string };
        expect(['green', 'amber', 'red']).toContain(body.rag_status);
      });

      it('product detail rag_status is consistent with score (observe state → 0 score → red)', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        const body = JSON.parse(res.body) as { overall_score_pct: number; rag_status: string };
        // With observe state score may be 0 (red) or scored if in enforced state
        if (body.overall_score_pct >= 90) expect(body.rag_status).toBe('green');
        else if (body.overall_score_pct >= 70) expect(body.rag_status).toBe('amber');
        else expect(body.rag_status).toBe('red');
      });
    });

    // ── 8. TSC category grouping ───────────────────────────────────────────────

    describe('TSC category grouping in product detail', () => {
      it('control CC-DASH-001 with tsc_category CC6 appears in categories', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        const body = JSON.parse(res.body) as {
          categories: Array<{ tsc_category: string; controls: Array<{ control_key: string }> }>;
        };
        const cc6 = body.categories.find((c) => c.tsc_category === 'CC6');
        expect(cc6).toBeDefined();
        expect(cc6!.controls.some((c) => c.control_key === DASH_CONTROL_KEY)).toBe(true);
      });

      it('product detail controls field is always an array (never undefined)', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/dashboard/products/${productId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        const body = JSON.parse(res.body) as {
          categories: Array<{ controls: unknown }>;
        };
        for (const cat of body.categories) {
          expect(Array.isArray(cat.controls)).toBe(true);
        }
      });
    });
  },
);
