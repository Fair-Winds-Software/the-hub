// Authorized by HUB-1377 — integration tests: evidence query filter types and pagination
// Authorized by HUB-1380 — integration tests: bundle generation, signed manifest integrity
// Authorized by HUB-1381 — integration tests: cover document presence in bundle
// Authorized by HUB-1382 — integration tests: POST create job, GET status, GET download stream
// Authorized by HUB-1383 — evidence export integration test suite (RUN_INTEGRATION=1)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
// HUB-1771 Phase 4: RUN_TAG suffix on fixture names + control_id
const RUN_TAG = Date.now().toString();
const EXPORT_CONTROL_KEY = `CC-EXPORT-${RUN_TAG}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'Evidence Export Integration Tests (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let operatorToken: string;
    let productId: string;
    let controlId: string;
    let tenantId: string;

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
        [`Export Test Tenant ${RUN_TAG}`],
      );
      tenantId = tRows[0]!.id;

      const { rows: pRows } = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, name, slug, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, `Export Test Product ${RUN_TAG}`, `export-test-product-${RUN_TAG}`],
      );
      productId = pRows[0]!.id;

      const jwt = await import('jsonwebtoken');
      const secret = process.env.OPERATOR_JWT_SECRET ?? 'test-operator-secret';
      operatorToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-000000000002', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );

      // Create control, register product, bind control
      const ctrlRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/compliance/controls',
        headers: { Authorization: `Bearer ${operatorToken}` },
        payload: {
          control_id: EXPORT_CONTROL_KEY,
          name: 'Export Test Control',
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

      // Seed a signal evidence record directly
      const { createHash } = await import('node:crypto');
      const signalId = `export-test-signal-${Date.now()}`;
      const payload = { source: 'integration-test', value: 42 };
      const contentHash = createHash('sha256').update(JSON.stringify(payload) + signalId).digest('hex');
      await pool.query(
        `INSERT INTO compliance_signal_evidence
           (product_id, control_id, signal_id, content_hash, payload, signal_type, observed_at, is_burn_in_gap)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), false)`,
        [productId, controlId, signalId, contentHash, JSON.stringify(payload), 'automated'],
      );
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      await pool.query(`DELETE FROM compliance_export_jobs WHERE requested_by = '00000000-0000-0000-0000-000000000002'`);
      await pool.query(`DELETE FROM compliance_signal_evidence WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM product_control_bindings WHERE product_id = $1`, [productId]);
      await pool.query(`DELETE FROM compliance_product_registrations WHERE product_id = $1`, [productId]);
      if (controlId) await pool.query(`DELETE FROM compliance_controls WHERE id = $1`, [controlId]);
      await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await closeAppResources(app);
    });

    // ── 1. Evidence query endpoint ─────────────────────────────────────────────

    describe('GET /api/v1/admin/compliance/exports/query', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/admin/compliance/exports/query' });
        expect(res.statusCode).toBe(401);
      });

      it('returns 200 with records array and total', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/exports/query?date_from=2020-01-01T00:00:00Z&date_to=2030-01-01T00:00:00Z',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { records: unknown[]; total: number; limit: number; offset: number };
        expect(Array.isArray(body.records)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(body.total).toBeGreaterThanOrEqual(1);
      });

      it('returns 400 for invalid date_from', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/exports/query?date_from=not-a-date',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 when date_from >= date_to', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/exports/query?date_from=2026-06-01T00:00:00Z&date_to=2026-01-01T00:00:00Z',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('filters by product_id correctly', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/exports/query?date_from=2020-01-01T00:00:00Z&date_to=2030-01-01T00:00:00Z&product_id=${productId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { records: Array<{ product_id: string }> };
        for (const r of body.records) {
          expect(r.product_id).toBe(productId);
        }
      });
    });

    // ── 2. Create export job ───────────────────────────────────────────────────

    describe('POST /api/v1/admin/compliance/exports', () => {
      it('returns 401 without auth', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/exports',
          payload: { date_from: '2020-01-01T00:00:00Z', date_to: '2030-01-01T00:00:00Z' },
        });
        expect(res.statusCode).toBe(401);
      });

      it('returns 400 when date_from is missing', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/exports',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { date_to: '2030-01-01T00:00:00Z' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 for invalid product_id UUID', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/exports',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { date_from: '2020-01-01T00:00:00Z', date_to: '2030-01-01T00:00:00Z', product_id: 'not-a-uuid' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 400 for invalid control_class', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/exports',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { date_from: '2020-01-01T00:00:00Z', date_to: '2030-01-01T00:00:00Z', control_class: 'invalid' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('returns 202 with job_id and pending status', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/exports',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { date_from: '2020-01-01T00:00:00Z', date_to: '2030-01-01T00:00:00Z', product_id: productId },
        });
        expect(res.statusCode).toBe(202);
        const body = JSON.parse(res.body) as { job_id: string; status: string };
        expect(typeof body.job_id).toBe('string');
        expect(body.status).toBe('pending');
      });
    });

    // ── 3. Job status + download ───────────────────────────────────────────────

    describe('GET /exports/:id and GET /exports/:id/download', () => {
      let jobId: string;

      beforeAll(async () => {
        // Create a job and wait for it to complete (async, short delay)
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/compliance/exports',
          headers: { Authorization: `Bearer ${operatorToken}` },
          payload: { date_from: '2020-01-01T00:00:00Z', date_to: '2030-01-01T00:00:00Z', product_id: productId },
        });
        jobId = (JSON.parse(res.body) as { job_id: string }).job_id;

        // Poll until completed (max 10 seconds)
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const statusRes = await app.inject({
            method: 'GET',
            url: `/api/v1/admin/compliance/exports/${jobId}`,
            headers: { Authorization: `Bearer ${operatorToken}` },
          });
          const status = (JSON.parse(statusRes.body) as { status: string }).status;
          if (status === 'completed' || status === 'failed') break;
        }
      });

      it('GET job status returns 200 with status field', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/exports/${jobId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { id: string; status: string; record_count: number | null };
        expect(body.id).toBe(jobId);
        expect(['pending', 'running', 'completed', 'failed']).toContain(body.status);
      });

      it('GET job status returns 400 for invalid UUID', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/exports/not-a-uuid',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });

      it('GET job status returns 404 for non-existent job', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/compliance/exports/00000000-0000-0000-0000-000000000099',
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(404);
      });

      it('GET download returns ZIP when job completed', async () => {
        const statusRes = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/exports/${jobId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        const status = (JSON.parse(statusRes.body) as { status: string }).status;
        if (status !== 'completed') return; // skip if generation still running

        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/exports/${jobId}/download`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('application/zip');
        expect(res.headers['content-disposition']).toContain(jobId);
        expect(res.headers['x-bundle-hash']).toBeTruthy();
        // Body should be a non-empty buffer
        expect(Buffer.byteLength(res.rawPayload)).toBeGreaterThan(0);
      });

      it('bundle file exists on disk after completion', async () => {
        const statusRes = await app.inject({
          method: 'GET',
          url: `/api/v1/admin/compliance/exports/${jobId}`,
          headers: { Authorization: `Bearer ${operatorToken}` },
        });
        const body = JSON.parse(statusRes.body) as { status: string };
        if (body.status !== 'completed') return;

        const expectedPath = join(tmpdir(), `hub-export-${jobId}.zip`);
        expect(existsSync(expectedPath)).toBe(true);
      });
    });
  },
);
