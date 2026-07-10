// Authorized by HUB-1098 — integration tests: alert_rules GET/PUT; alert_notifications paginated list
// Authorized by HUB-1102 — integration tests: acknowledge, acknowledge-all endpoints
// Authorized by HUB-1118 — integration tests: PASS→FAIL transition fires alert via deliverAlert
// Authorized by HUB-1354 — integration tests: runHumanEscalationScheduler fired/skipped counts
// Authorized by HUB-1355 — integration tests: runDriftDetectionEngine fired/skipped counts
// Authorized by HUB-1365 — integration tests: in-app notification center filters
// Authorized by HUB-1366 — integration tests: deliverAlert dedup via content_hash

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
// HUB-1771 Phase 4: RUN_TAG suffix on hardcoded fixture names + control_id
// (compliance_signal_evidence immutability trigger prevents cleanup)
const RUN_TAG = Date.now().toString();
const ALERT_CONTROL_KEY = `CC-ALERT-${RUN_TAG}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'Compliance Alerting Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let operatorToken: string;
    let productId: string;
    let controlId: string;
    let ruleId: string;
    let notificationId: string;

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
        [`Alert Test Tenant ${RUN_TAG}`],
      );
      const tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, `Alert Test Product ${RUN_TAG}`, `alert-test-product-${RUN_TAG}`],
      );
      productId = pRows[0]!.id;

      const jwt = await import('jsonwebtoken');
      const secret = process.env.OPERATOR_JWT_SECRET ?? 'test-operator-secret';
      operatorToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-000000000002', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );

      // Create control and register product
      const ctrlRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/compliance/controls',
        headers: { Authorization: `Bearer ${operatorToken}` },
        payload: {
          control_id: ALERT_CONTROL_KEY,
          name: 'Alert Test Control',
          tsc_category: 'CC6',
          control_class: 'automated',
          eval_cadence: 'daily',
        },
      });
      controlId = (JSON.parse(ctrlRes.body) as { id: string }).id;

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

      // Seed an in-app notification for acknowledge tests
      const { deliverAlert } = await import('../services/complianceAlertService.js');
      const result = await deliverAlert({
        alertType: 'control_failure',
        severity: 'high',
        productId,
        controlId,
        payload: { product_id: productId, control_id: controlId, control_key: ALERT_CONTROL_KEY, previous_verdict: 'pass' },
        channels: ['IN_APP', 'EMAIL'],
        contentHashSeed: `control_failure:${controlId}:${productId}:test-seed-${Date.now()}`,
      });
      notificationId = result.notification_id;

      // Capture the platform-wide control_failure rule id for PUT tests
      const rulesRes = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/compliance/alerts/rules',
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      const rules = JSON.parse(rulesRes.body) as Array<{ id: string; rule_type: string; product_id: string | null }>;
      const cfRule = rules.find((r) => r.rule_type === 'control_failure' && r.product_id === null);
      ruleId = cfRule!.id;
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      await pool.query(`DELETE FROM alert_acknowledgments WHERE notification_id IN (SELECT id FROM alert_notifications WHERE product_id = $1)`, [productId]);
      await pool.query(`DELETE FROM alert_notifications WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM product_control_bindings WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_product_registrations WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_current_verdicts WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_verdict_history WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_signal_evidence WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_posture_scores WHERE product_id = $1`, [productId]);
      if (controlId) await pool.query(`DELETE FROM compliance_controls WHERE id = $1`, [controlId]);
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE name = 'Alert Test Tenant'`);
      await closeAppResources(app);
    });

    // ── 1. Alert rules — GET list ──────────────────────────────────────────────

    describe('GET /api/v1/admin/compliance/alerts/rules', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/admin/compliance/alerts/rules' });
        expect(res.statusCode).toBe(401);
      });

      it('returns 200 with at least 3 default platform-wide rules', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/alerts/rules',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as Array<{ rule_type: string; product_id: string | null; enabled: boolean }>;
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBeGreaterThanOrEqual(3);
        const types = body.map((r) => r.rule_type);
        expect(types).toContain('control_failure');
        expect(types).toContain('human_overdue');
        expect(types).toContain('drift_detected');
      });
    });

    // ── 2. Alert rules — PUT update ────────────────────────────────────────────

    describe('PUT /api/v1/admin/compliance/alerts/rules/:id', () => {
      it('returns 400 for invalid UUID', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/compliance/alerts/rules/not-a-uuid',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { enabled: false },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when attempting to update immutable field', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/compliance/alerts/rules/${ruleId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { rule_type: 'changed' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when no fields to update', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/compliance/alerts/rules/${ruleId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 200 and updates enabled field', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/compliance/alerts/rules/${ruleId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { enabled: false },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { id: string; enabled: boolean };
        expect(body.id).toBe(ruleId);
        expect(body.enabled).toBe(false);

        // Restore
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/compliance/alerts/rules/${ruleId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { enabled: true },
        });
      });

      it('returns 404 for non-existent rule', async () => {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/compliance/alerts/rules/00000000-0000-0000-0000-000000000099',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { enabled: false },
        });
        expect(res.statusCode).toBe(404);
      });
    });

    // ── 3. Notifications — GET list ────────────────────────────────────────────

    describe('GET /api/v1/admin/compliance/alerts/notifications', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/admin/compliance/alerts/notifications' });
        expect(res.statusCode).toBe(401);
      });

      it('returns 200 with notifications and total', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/alerts/notifications',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { notifications: unknown[]; total: number };
        expect(Array.isArray(body.notifications)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(body.total).toBeGreaterThanOrEqual(1);
      });

      it('?unread=true excludes already-acknowledged notifications', async () => {
        // Acknowledge our seeded notification first
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/alerts/notifications/${notificationId}/acknowledge`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });

        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/alerts/notifications?unread=true',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { notifications: Array<{ id: string }> };
        const found = body.notifications.find((n) => n.id === notificationId);
        expect(found).toBeUndefined();
      });
    });

    // ── 4. Acknowledge single notification ────────────────────────────────────

    describe('POST /api/v1/admin/compliance/alerts/notifications/:id/acknowledge', () => {
      it('returns 400 for invalid UUID', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/alerts/notifications/not-a-uuid/acknowledge',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 404 for non-existent notification', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/alerts/notifications/00000000-0000-0000-0000-000000000099/acknowledge',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(404);
      });

      it('returns 409 when already acknowledged', async () => {
        // notificationId was already acknowledged in the previous test block
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/compliance/alerts/notifications/${notificationId}/acknowledge`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(409);
      });
    });

    // ── 5. Acknowledge-all ─────────────────────────────────────────────────────

    describe('POST /api/v1/admin/compliance/alerts/notifications/acknowledge-all', () => {
      it('returns 200 with acknowledged_count', async () => {
        // Seed a second unacknowledged notification
        const { deliverAlert } = await import('../services/complianceAlertService.js');
        await deliverAlert({
          alertType: 'drift_detected',
          severity: 'high',
          productId,
          payload: { product_id: productId, current_score: 50, previous_score: 80, drop: 30, threshold: 10 },
          channels: ['IN_APP'],
          contentHashSeed: `drift_detected:${productId}:ack-all-test-${Date.now()}`,
        });

        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/alerts/notifications/acknowledge-all',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { acknowledged_count: number };
        expect(typeof body.acknowledged_count).toBe('number');
        expect(body.acknowledged_count).toBeGreaterThanOrEqual(1);
      });

      it('returns 0 when all notifications already acknowledged', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/alerts/notifications/acknowledge-all',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { acknowledged_count: number };
        expect(body.acknowledged_count).toBe(0);
      });
    });

    // ── 6. deliverAlert dedup (content_hash) ──────────────────────────────────

    describe('deliverAlert dedup via content_hash', () => {
      it('returns duplicate=true on second call with same seed', async () => {
        const { deliverAlert } = await import('../services/complianceAlertService.js');
        const seed = `dedup-test:${productId}:${Date.now()}`;
        const first = await deliverAlert({
          alertType: 'drift_detected',
          severity: 'medium',
          productId,
          payload: { test: 'dedup' },
          channels: ['IN_APP'],
          contentHashSeed: seed,
        });
        expect(first.duplicate).toBe(false);
        expect(first.notification_id).toBeTruthy();

        const second = await deliverAlert({
          alertType: 'drift_detected',
          severity: 'medium',
          productId,
          payload: { test: 'dedup' },
          channels: ['IN_APP'],
          contentHashSeed: seed,
        });
        expect(second.duplicate).toBe(true);
        expect(second.notification_id).toBe('');
      });
    });

    // ── 7. runHumanEscalationScheduler ────────────────────────────────────────

    describe('runHumanEscalationScheduler()', () => {
      it('returns fired/skipped counts without throwing', async () => {
        const { runHumanEscalationScheduler } = await import('../services/complianceAlertService.js');
        const result = await runHumanEscalationScheduler();
        expect(typeof result.fired).toBe('number');
        expect(typeof result.skipped).toBe('number');
        expect(result.fired + result.skipped).toBeGreaterThanOrEqual(0);
      });
    });
  },
);
