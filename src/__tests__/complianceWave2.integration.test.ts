// Authorized by HUB-1051 — E866 Wave 2 integration tests; verdict logic, human/automated, posture aggregation, query API; gated behind RUN_INTEGRATION=1

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
// HUB-1771 Phase 4: RUN_TAG suffix on fixture names
const RUN_TAG = Date.now().toString();

(RUN_INTEGRATION ? describe : describe.skip)(
  'E866 Wave 2 Compliance Evaluation Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let operatorToken: string;
    let tenantId: string;
    let productId: string;
    let automatedControlUUID: string;
    let humanControlUUID: string;
    let hmacSecret: string;

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
        [`Wave2 Eval Tenant ${RUN_TAG}`],
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, `Wave2 Eval Product ${RUN_TAG}`, `wave2-eval-product-${RUN_TAG}`],
      );
      productId = pRows[0]!.id;

      const jwt = await import('jsonwebtoken');
      const secret = process.env.OPERATOR_JWT_SECRET ?? 'test-operator-secret';
      operatorToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-000000000002', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );

      // Create an automated and a human control
      const autoRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/compliance/controls',
        headers: { Authorization: `Bearer ${operatorToken}` },
        payload: {
          control_id: 'CC-W2-AUTO-001',
          name: 'Automated Control',
          tsc_category: 'CC6',
          control_class: 'automated',
          eval_cadence: 'daily',
        },
      });
      automatedControlUUID = (JSON.parse(autoRes.body) as { id: string }).id;

      const humanRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/compliance/controls',
        headers: { Authorization: `Bearer ${operatorToken}` },
        payload: {
          control_id: 'CC-W2-HUMAN-001',
          name: 'Human Control',
          tsc_category: 'CC7',
          control_class: 'human',
          eval_cadence: 'weekly',
        },
      });
      humanControlUUID = (JSON.parse(humanRes.body) as { id: string }).id;

      // Register product + bind both controls
      const regRes = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/compliance/products/${productId}/register`,
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      hmacSecret = (JSON.parse(regRes.body) as { hmac_secret: string }).hmac_secret;

      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/compliance/products/${productId}/bindings`,
        headers: { Authorization: `Bearer ${operatorToken}` },
        payload: { control_id: automatedControlUUID },
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/compliance/products/${productId}/bindings`,
        headers: { Authorization: `Bearer ${operatorToken}` },
        payload: { control_id: humanControlUUID },
      });
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      await pool.query(`DELETE FROM compliance_posture_scores WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_verdict_history WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_current_verdicts WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_signal_evidence WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM product_control_bindings WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_signal_rejections WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_product_registrations WHERE product_id = $1`, [productId]);
      if (automatedControlUUID) {
        await pool.query(`DELETE FROM compliance_controls WHERE id IN ($1, $2)`, [automatedControlUUID, humanControlUUID]);
      }
      // Remove orphaned evaluation runs (no product FK — safe to leave, but clean up by run age)
      await pool.query(
        `DELETE FROM compliance_evaluation_runs WHERE started_at > NOW() - INTERVAL '1 hour'`,
      );
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await closeAppResources(app);
    });

    // ── Observe-state evaluation ───────────────────────────────────────────────

    describe('observe-state product gets observe verdicts', () => {
      it('running evaluation with product in observe state produces observe verdicts', async () => {
        const { runComplianceEvaluation } = await import('../services/complianceEvaluationService.js');
        const result = await runComplianceEvaluation();
        expect(result.verdicts.observe).toBeGreaterThanOrEqual(2);
        expect(result.verdicts.pass).toBe(0);
        expect(result.verdicts.fail).toBe(0);
        expect(result.verdicts.overdue).toBe(0);
      });

      it('GET /verdicts returns observe for both controls', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/verdicts`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as Array<{ verdict: string }>;
        expect(body.every((v) => v.verdict === 'observe')).toBe(true);
      });
    });

    // ── Promote to enforced ────────────────────────────────────────────────────

    describe('after promotion to enforced, no signal = fail/overdue', () => {
      it('promote product to enforced', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/products/${productId}/promote`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
      });

      it('evaluation with no signals: automated=fail, human=overdue', async () => {
        const { runComplianceEvaluation } = await import('../services/complianceEvaluationService.js');
        const result = await runComplianceEvaluation();
        // The product now has enforced state
        expect(result.verdicts.fail).toBeGreaterThanOrEqual(1);
        expect(result.verdicts.overdue).toBeGreaterThanOrEqual(1);
      });

      it('GET /verdicts shows fail for automated and overdue for human', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/verdicts`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as Array<{ control_key: string; verdict: string }>;
        const auto = body.find((v) => v.control_key === 'CC-W2-AUTO-001');
        const human = body.find((v) => v.control_key === 'CC-W2-HUMAN-001');
        expect(auto?.verdict).toBe('fail');
        expect(human?.verdict).toBe('overdue');
      });
    });

    // ── Signal ingestion + pass verdict ───────────────────────────────────────

    describe('after ingesting signals, automated=pass and human=pass', () => {
      it('ingest signals for both controls', async () => {
        function signedPayload(payload: object): { body: string; sig: string } {
          const body = JSON.stringify(payload);
          const sig = `sha256=${createHmac('sha256', hmacSecret).update(body).digest('hex')}`;
          return { body, sig };
        }

        const autoSig = signedPayload({
          product_id: productId,
          signal_id: `w2-auto-${Date.now()}`,
          control_id: 'CC-W2-AUTO-001',
          signal_type: 'automated_check',
          observed_at: new Date().toISOString(),
          payload: { result: 'pass' },
        });
        const r1 = await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature': autoSig.sig },
          body: autoSig.body,
        });
        expect((JSON.parse(r1.body) as { received: boolean }).received).toBe(true);

        const humanSig = signedPayload({
          product_id: productId,
          signal_id: `w2-human-${Date.now()}`,
          control_id: 'CC-W2-HUMAN-001',
          signal_type: 'attestation',
          observed_at: new Date().toISOString(),
          payload: { attested_by: 'test-user' },
        });
        const r2 = await app.inject({
          method: 'POST',
          url: '/api/v1/compliance/signals',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature': humanSig.sig },
          body: humanSig.body,
        });
        expect((JSON.parse(r2.body) as { received: boolean }).received).toBe(true);
      });

      it('evaluation after signals: both controls pass', async () => {
        const { runComplianceEvaluation } = await import('../services/complianceEvaluationService.js');
        const result = await runComplianceEvaluation();
        expect(result.verdicts.pass).toBeGreaterThanOrEqual(2);
        expect(result.verdicts.fail).toBe(0);
        expect(result.verdicts.overdue).toBe(0);
      });

      it('GET /verdicts shows pass for both controls', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/verdicts`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as Array<{ verdict: string }>;
        expect(body.every((v) => v.verdict === 'pass')).toBe(true);
      });
    });

    // ── Posture score ──────────────────────────────────────────────────────────

    describe('GET /api/v1/admin/compliance/products/:productId/posture', () => {
      it('returns overall score and per-category breakdown', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/posture`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          overall_score_pct: number;
          categories: Array<{ tsc_category: string; score_pct: number }>;
        };
        expect(typeof body.overall_score_pct).toBe('number');
        expect(body.overall_score_pct).toBe(100);
        expect(Array.isArray(body.categories)).toBe(true);
        expect(body.categories.some((c) => c.tsc_category === 'CC6')).toBe(true);
        expect(body.categories.some((c) => c.tsc_category === 'CC7')).toBe(true);
      });
    });

    // ── Verdict history ────────────────────────────────────────────────────────

    describe('GET /api/v1/admin/compliance/products/:productId/history', () => {
      it('returns paginated history with total', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/history`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { history: unknown[]; total: number };
        expect(Array.isArray(body.history)).toBe(true);
        expect(body.total).toBeGreaterThan(0);
        // Multiple evaluation runs were performed in tests above, so history > 2
        expect(body.total).toBeGreaterThanOrEqual(4);
      });

      it('respects limit and offset', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/history?limit=2&offset=0`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { history: unknown[]; total: number };
        expect(body.history.length).toBeLessThanOrEqual(2);
      });
    });

    // ── Access control on query endpoints ──────────────────────────────────────

    describe('access control on query endpoints', () => {
      it('GET /posture without auth returns 401', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/products/${productId}/posture`,
        });
        expect(res.statusCode).toBe(401);
      });
    });
  },
);
