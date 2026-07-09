// Authorized by HUB-1142 — integration tests: POST run advisor; sync + async modes; 202 response
// Authorized by HUB-1143 — integration tests: GET latest recommendation; 404 when none; stale flag
// Authorized by HUB-1144 — integration tests: POST outcome; 400 validations; 404 not found
// Authorized by HUB-1149 — integration tests: GET portfolio/summary aggregate shape

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'Plan Advisor Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let operatorToken: string;
    let tenantId: string;
    let productId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const { getPool } = await import('../db/pool.js');
      const pool = getPool();

      const { rows: tRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ('Advisor Test Tenant', 'external', true)
         RETURNING id`,
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, 'Advisor Test Product', 'advisor-test-product', true)
         RETURNING id`,
        [tenantId],
      );
      productId = pRows[0]!.id;

      // Seed a pricing model so cost projection has data
      await pool.query(
        `INSERT INTO pricing_models
           (product_id, model_type, currency, config, active, activated_at)
         VALUES ($1, 'flat_rate', 'usd', $2, true, NOW())`,
        [productId, JSON.stringify({ price_cents: 5000 })],
      );

      const jwt = await import('jsonwebtoken');
      const secret = process.env.OPERATOR_JWT_SECRET ?? 'test-operator-secret';
      operatorToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-000000000002', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      await pool.query(`DELETE FROM advisor_outcomes WHERE recommendation_id IN (
        SELECT id FROM advisor_recommendations WHERE product_id = $1
      )`, [productId]);
      await pool.query(`DELETE FROM advisor_recommendations WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM pricing_models WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await closeAppResources(app);
    });

    // ── 1. Run advisor ─────────────────────────────────────────────────────────

    describe('POST /api/v1/admin/advisor/:productId/:tenantId/run', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/run`,
        });
        expect(res.statusCode).toBe(401);
      });

      it('returns 400 for invalid productId UUID', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/not-a-uuid/${tenantId}/run`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 for invalid tenantId UUID', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/${productId}/not-a-uuid/run`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 200 with recommendation when no billing history (stay / low confidence)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/run`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          recommendation_type: string;
          confidence: string;
          periods_analyzed: number;
          week_start: string;
          recommendation: { id: string };
        };
        expect(['upgrade', 'downgrade', 'switch_to_annual', 'stay']).toContain(body.recommendation_type);
        expect(['high', 'medium', 'low']).toContain(body.confidence);
        expect(body.periods_analyzed).toBe(0); // no billing_period_costs seeded
        expect(typeof body.week_start).toBe('string');
        expect(typeof body.recommendation.id).toBe('string');
      });

      it('returns 202 for async mode', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/run?async=true`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(202);
        const body = JSON.parse(res.body) as { status: string };
        expect(body.status).toBe('queued');
      });
    });

    // ── 2. Get latest recommendation ──────────────────────────────────────────

    describe('GET /api/v1/admin/advisor/:productId/:tenantId/latest', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/latest`,
        });
        expect(res.statusCode).toBe(401);
      });

      it('returns 200 with recommendation and stale flag after run', async () => {
        // Ensure a recommendation exists
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/run`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });

        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/latest`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { recommendation: { id: string }; stale: boolean };
        expect(typeof body.recommendation.id).toBe('string');
        expect(typeof body.stale).toBe('boolean');
        expect(body.stale).toBe(false); // just created
      });

      it('returns 404 for product+tenant with no recommendations', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/advisor/00000000-0000-0000-0000-000000000001/${tenantId}/latest`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── 3. Record outcome ─────────────────────────────────────────────────────

    describe('POST /api/v1/admin/advisor/recommendations/:id/outcome', () => {
      let recommendationId: string;

      beforeAll(async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/run`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        recommendationId = (JSON.parse(res.body) as { recommendation: { id: string } }).recommendation.id;
      });

      it('returns 400 when outcome_type is missing', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/recommendations/${recommendationId}/outcome`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 for invalid outcome_type', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/recommendations/${recommendationId}/outcome`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { outcome_type: 'invalid_type' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 for invalid UUID', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/advisor/recommendations/not-a-uuid/outcome',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { outcome_type: 'applied' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 404 for non-existent recommendation', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/advisor/recommendations/00000000-0000-0000-0000-000000000099/outcome',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { outcome_type: 'dismissed' },
        });
        expect(res.statusCode).toBe(404);
      });

      it('returns 201 with outcome when valid', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/recommendations/${recommendationId}/outcome`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { outcome_type: 'applied', notes: 'Upgraded plan successfully' },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { id: string; recommendation_id: string; outcome_type: string };
        expect(body.recommendation_id).toBe(recommendationId);
        expect(body.outcome_type).toBe('applied');
      });
    });

    // ── 4. Portfolio summary ───────────────────────────────────────────────────

    describe('GET /api/v1/admin/advisor/portfolio/summary', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/admin/advisor/portfolio/summary' });
        expect(res.statusCode).toBe(401);
      });

      it('returns 200 with summary shape', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/advisor/portfolio/summary',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          total_products: number;
          open_recommendations: number;
          upgrade_count: number;
          downgrade_count: number;
          switch_to_annual_count: number;
          stay_count: number;
          high_confidence_count: number;
          rows: unknown[];
        };
        expect(typeof body.total_products).toBe('number');
        expect(typeof body.open_recommendations).toBe('number');
        expect(typeof body.upgrade_count).toBe('number');
        expect(Array.isArray(body.rows)).toBe(true);
      });
    });
  },
);
