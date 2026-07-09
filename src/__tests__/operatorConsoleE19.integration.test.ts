// Authorized by HUB-1146 — integration tests: GET /console/pricing/:productId/overview
// Authorized by HUB-1147 — integration tests: tenant list, plan assign, discounts, overrides, audit log
// Authorized by HUB-1148 — integration tests: billing-summary, audit-note, recommendation history
// Authorized by HUB-1149 — integration tests: enhanced portfolio summary shape + CSV export

// Authorized by HUB-1771 Phase 1.4 — RUN_TAG suffix on fixture names to avoid
// UNIQUE(slug) / UNIQUE(tenant_id, name) collisions from prior aborted runs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const RUN_TAG = Date.now().toString();

(RUN_INTEGRATION ? describe : describe.skip)(
  'Operator Console E19 Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let operatorToken: string;
    let tenantId: string;
    let productId: string;
    let modelId: string;
    let discountId: string;
    let overrideId: string;
    let recommendationId: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const { getPool } = await import('../db/pool.js');
      const pool = getPool();

      const { rows: tRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ($1, 'external', true)
         RETURNING id`,
        [`E19 Console Test Tenant ${RUN_TAG}`],
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, `E19 Console Test Product ${RUN_TAG}`, `e19-console-test-product-${RUN_TAG}`],
      );
      productId = pRows[0]!.id;

      const { rows: mRows } = await pool.query<{ id: string }>(
        `INSERT INTO pricing_models
           (product_id, model_type, currency, config, active, activated_at)
         VALUES ($1, 'flat_rate', 'usd', $2, true, NOW())
         RETURNING id`,
        [productId, JSON.stringify({ price_cents: 4900 })],
      );
      modelId = mRows[0]!.id;

      // Seed a recommendation for HUB-1148 tests
      const { rows: recRows } = await pool.query<{ id: string }>(
        `INSERT INTO advisor_recommendations
           (product_id, tenant_id, recommendation_type, rationale, confidence, status, week_start, periods_analyzed)
         VALUES ($1, $2, 'stay', 'No change needed', 'low', 'open', CURRENT_DATE, 0)
         RETURNING id`,
        [productId, tenantId],
      );
      recommendationId = recRows[0]!.id;

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
      await pool.query(`DELETE FROM operator_audit_log WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM tenant_pricing_overrides WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM tenant_discounts WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM tenant_plan_assignments WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM advisor_outcomes WHERE recommendation_id IN (
        SELECT id FROM advisor_recommendations WHERE product_id = $1
      )`, [productId]);
      await pool.query(`DELETE FROM advisor_recommendations WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM pricing_models WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await app.close();
    });

    // ── 1. Pricing overview (HUB-1146) ────────────────────────────────────────

    describe('GET /api/v1/admin/console/pricing/:productId/overview', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/console/pricing/${productId}/overview`,
        });
        expect(res.statusCode).toBe(401);
      });

      it('returns 400 for invalid productId', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/console/pricing/not-a-uuid/overview',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 200 with active_model and history', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/console/pricing/${productId}/overview`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { active_model: { model_id: string } | null; history: unknown[] };
        expect(Array.isArray(body.history)).toBe(true);
      });
    });

    // ── 2. Tenant list (HUB-1147) ─────────────────────────────────────────────

    describe('GET /api/v1/admin/console/tenants', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/console/tenants?product_id=${productId}`,
        });
        expect(res.statusCode).toBe(401);
      });

      it('returns 400 when product_id is missing', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/console/tenants',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 200 with paginated tenant list', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/console/tenants?product_id=${productId}&limit=10&offset=0`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { data: unknown[]; total: number };
        expect(Array.isArray(body.data)).toBe(true);
        expect(typeof body.total).toBe('number');
      });
    });

    // ── 3. Plan assignment — single (HUB-1147) ────────────────────────────────

    describe('POST /api/v1/admin/console/plans/assign', () => {
      it('returns 400 when tenant_id is missing', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/plans/assign',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { product_id: productId, pricing_model_id: modelId },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 for invalid effective_date_type', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/plans/assign',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {
            tenant_id: tenantId,
            product_id: productId,
            pricing_model_id: modelId,
            effective_date_type: 'next_quarter',
          },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 201 with assignment on valid input', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/plans/assign',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {
            tenant_id: tenantId,
            product_id: productId,
            pricing_model_id: modelId,
            effective_date_type: 'immediate',
          },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { id: string; effective_date_type: string };
        expect(typeof body.id).toBe('string');
        expect(body.effective_date_type).toBe('immediate');
      });
    });

    // ── 4. Bulk plan assignment (HUB-1147) ────────────────────────────────────

    describe('POST /api/v1/admin/console/plans/assign/bulk', () => {
      it('returns 400 when tenant_ids exceeds 50', async () => {
        const ids = Array.from({ length: 51 }, () => '00000000-0000-0000-0000-000000000001');
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/plans/assign/bulk',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { tenant_ids: ids, product_id: productId, pricing_model_id: modelId },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 207 with succeeded/failed on valid input', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/plans/assign/bulk',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {
            tenant_ids: [tenantId],
            product_id: productId,
            pricing_model_id: modelId,
            effective_date_type: 'next_billing_cycle',
          },
        });
        expect(res.statusCode).toBe(207);
        const body = JSON.parse(res.body) as { succeeded: string[]; failed: unknown[] };
        expect(Array.isArray(body.succeeded)).toBe(true);
        expect(Array.isArray(body.failed)).toBe(true);
      });
    });

    // ── 5. Discounts (HUB-1147) ───────────────────────────────────────────────

    describe('POST /api/v1/admin/console/discounts', () => {
      it('returns 400 for invalid discount_type', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/discounts',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { tenant_id: tenantId, product_id: productId, discount_type: 'bogus', discount_value: 10 },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 201 with discount on valid input', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/discounts',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {
            tenant_id: tenantId,
            product_id: productId,
            discount_type: 'percentage',
            discount_value: 20,
            notes: 'Early adopter discount',
          },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { id: string; discount_type: string };
        expect(typeof body.id).toBe('string');
        expect(body.discount_type).toBe('percentage');
        discountId = body.id;
      });
    });

    describe('GET /api/v1/admin/console/discounts/:tenantId/:productId', () => {
      it('returns 200 with discount list', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/console/discounts/${tenantId}/${productId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { data: unknown[] };
        expect(Array.isArray(body.data)).toBe(true);
      });
    });

    describe('DELETE /api/v1/admin/console/discounts/:discountId', () => {
      it('returns 204 on valid delete', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/console/discounts/${discountId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(204);
      });

      it('returns 404 on already-deleted discount', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/console/discounts/${discountId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── 6. Pricing overrides (HUB-1147) ──────────────────────────────────────

    describe('POST /api/v1/admin/console/overrides', () => {
      it('returns 400 when metric_name is missing', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/overrides',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { tenant_id: tenantId, product_id: productId, unit_price_cents: 100 },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 201 with override on valid input', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/console/overrides',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {
            tenant_id: tenantId,
            product_id: productId,
            metric_name: 'api_call',
            unit_price_cents: 2,
          },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { id: string; metric_name: string };
        expect(body.metric_name).toBe('api_call');
        overrideId = body.id;
      });
    });

    describe('GET /api/v1/admin/console/overrides/:tenantId/:productId', () => {
      it('returns 200 with override list', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/console/overrides/${tenantId}/${productId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { data: unknown[] };
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);
      });
    });

    describe('DELETE /api/v1/admin/console/overrides/:overrideId', () => {
      it('returns 204 on valid delete', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/console/overrides/${overrideId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(204);
      });
    });

    // ── 7. Audit log (HUB-1147) ───────────────────────────────────────────────

    describe('GET /api/v1/admin/console/audit-log', () => {
      it('returns 200 with audit log entries', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/console/audit-log?tenant_id=${tenantId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { data: unknown[]; total: number };
        expect(Array.isArray(body.data)).toBe(true);
        expect(typeof body.total).toBe('number');
      });
    });

    // ── 8. Billing summary (HUB-1148) ─────────────────────────────────────────

    describe('GET /api/v1/admin/advisor/:productId/:tenantId/billing-summary', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/billing-summary`,
        });
        expect(res.statusCode).toBe(401);
      });

      it('returns 200 with periods array', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/billing-summary`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { periods: unknown[] };
        expect(Array.isArray(body.periods)).toBe(true);
      });
    });

    // ── 9. Recommendation history (HUB-1148) ──────────────────────────────────

    describe('GET /api/v1/admin/advisor/:productId/:tenantId/history', () => {
      it('returns 200 with recommendations array', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/advisor/${productId}/${tenantId}/history`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { recommendations: unknown[] };
        expect(Array.isArray(body.recommendations)).toBe(true);
        expect(body.recommendations.length).toBeGreaterThan(0);
      });
    });

    // ── 10. Audit note (HUB-1148) ─────────────────────────────────────────────

    describe('POST /api/v1/admin/advisor/recommendations/:id/audit-note', () => {
      it('returns 400 when note is missing', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/recommendations/${recommendationId}/audit-note`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 404 for non-existent recommendation', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/advisor/recommendations/00000000-0000-0000-0000-000000000099/audit-note',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { note: 'Test note' },
        });
        expect(res.statusCode).toBe(404);
      });

      it('returns 201 with audit log entry', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/advisor/recommendations/${recommendationId}/audit-note`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { note: 'Discussed with tenant on call — staying on current plan' },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body) as { id: string; created_at: string };
        expect(typeof body.id).toBe('string');
        expect(typeof body.created_at).toBe('string');
      });
    });

    // ── 11. Enhanced portfolio summary (HUB-1149) ─────────────────────────────

    describe('GET /api/v1/admin/advisor/portfolio/summary', () => {
      it('returns 200 with enhanced shape including product_cards, churn_risk, margin_health', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/advisor/portfolio/summary',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          total_products: number;
          open_recommendations: number;
          product_cards: unknown[];
          churn_risk: unknown[];
          margin_health: unknown[];
          rows: unknown[];
        };
        expect(typeof body.total_products).toBe('number');
        expect(typeof body.open_recommendations).toBe('number');
        expect(Array.isArray(body.product_cards)).toBe(true);
        expect(Array.isArray(body.churn_risk)).toBe(true);
        expect(Array.isArray(body.margin_health)).toBe(true);
        expect(Array.isArray(body.rows)).toBe(true);
      });
    });

    // ── 12. Portfolio CSV export (HUB-1149) ───────────────────────────────────

    describe('GET /api/v1/admin/advisor/portfolio/summary/export', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/advisor/portfolio/summary/export',
        });
        expect(res.statusCode).toBe(401);
      });

      it('returns 200 with CSV content-type and header row', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/advisor/portfolio/summary/export',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(res.body).toContain('product_id');
      });
    });
  },
);
