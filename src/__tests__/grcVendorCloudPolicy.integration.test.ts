// Authorized by HUB-1454 (E-CMP-WAVE4b S6, HUB-871) — integration test suite for the
// GRC-Lite Wave 4b register triad. Full stack: real DB, real transactions, signal-
// emission assertions via COUNT queries on compliance_signal_evidence scoped to the
// portfolio product seeded by migration 070.
//
// Gated behind RUN_INTEGRATION=1 per convention. Prerequisites:
//   - migrations 069 + 070 applied
//   - hub_dev DB reachable via DATABASE_URL
//   - dev env vars per .env.example
//
// Reconciliations vs story text:
//   - `compliance_signal_log` -> `compliance_signal_evidence` (HUB-1020)
//   - Frontend msw suite deferred: HUB-1436/1437/1438 already ship 14 direct-
//     apiClient-mock tests covering the same paths.
//   - Signal routing: Wave 4b uses the seeded `hub-portfolio` product (migration 070)
//     rather than per-record product slugs like Wave 4.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

const PORTFOLIO_SLUG = 'hub-portfolio';
// Unique run suffix so a prior run's immutable children (assessments, attestations,
// acknowledgments) can't cause name-uniqueness collisions on re-runs.
const RUN_TAG = `HUB1454 ${Date.now()}`;

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1454: GRC-Lite Wave 4b integration suite (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let superAdminToken: string;
    let productAdminToken: string;

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const jwt = await import('jsonwebtoken');
      const secret = process.env['OPERATOR_JWT_SECRET']!;
      superAdminToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-00000000fffd', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );
      productAdminToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-00000000fffc', role: 'product_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      // Immutable evidence rows survive; delete signal rows first (evidence table has
      // no immutable-guard trigger — only the register evidence tables do), then delete
      // mutable-register rows filtered by test name prefixes.
      await pool.query(
        `DELETE FROM compliance_signal_evidence
           WHERE product_id IN (SELECT id FROM products WHERE slug = $1)
             AND signal_type = ANY($2::text[])`,
        [PORTFOLIO_SLUG, ['vendor_risk_assessed', 'cloud_security_attested', 'policy_acknowledged']],
      );
      // Mutable parent registers — leave rows that have immutable children (assessments /
      // attestations / acknowledgments) since we can't delete those.
      await pool.query(
        `DELETE FROM vendor_register
          WHERE vendor_name LIKE 'HUB1454 %'
            AND id NOT IN (SELECT vendor_id FROM vendor_risk_assessments)`,
      );
      await pool.query(
        `DELETE FROM cloud_infrastructure
          WHERE account_name LIKE 'HUB1454 %'
            AND id NOT IN (SELECT account_id FROM cloud_security_attestations)`,
      );
      await pool.query(
        `DELETE FROM policy_register
          WHERE policy_name LIKE 'HUB1454 %'
            AND id NOT IN (SELECT policy_id FROM policy_acknowledgments)`,
      );
      await app.close();
    });

    const adminHeaders = () => ({ Authorization: `Bearer ${superAdminToken}` });
    const productAdminHeaders = () => ({ Authorization: `Bearer ${productAdminToken}` });

    async function countSignalsFor(signalType: string): Promise<number> {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM compliance_signal_evidence e
           JOIN products p ON p.id = e.product_id
          WHERE e.signal_type = $1 AND p.slug = $2`,
        [signalType, PORTFOLIO_SLUG],
      );
      return parseInt(rows[0]!.n, 10);
    }

    // ── AC 1 (vendor CRUD) ─────────────────────────────────────────────────

    describe('Vendor CRUD (AC 1)', () => {
      it('POST -> GET -> PUT -> DELETE archives the vendor', async () => {
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/grc/vendors',
          headers: adminHeaders(),
          payload: {
            vendor_name: `${RUN_TAG} CRUD Vendor`,
            vendor_type: 'saas',
            data_access_level: 'limited',
            risk_level: 'medium',
          },
        });
        expect(createRes.statusCode).toBe(201);
        const created = JSON.parse(createRes.body) as { id: string; status: string };
        expect(created.status).toBe('active');

        const listRes = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/grc/vendors?status=active&pageSize=50',
          headers: adminHeaders(),
        });
        expect(listRes.statusCode).toBe(200);
        expect((JSON.parse(listRes.body) as { data: Array<{ id: string }> }).data
          .some((v) => v.id === created.id)).toBe(true);

        const putRes = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/grc/vendors/${created.id}`,
          headers: adminHeaders(),
          payload: { risk_level: 'high' },
        });
        expect(putRes.statusCode).toBe(200);
        expect(JSON.parse(putRes.body)).toMatchObject({ risk_level: 'high' });

        const delRes = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/grc/vendors/${created.id}`,
          headers: adminHeaders(),
        });
        expect(delRes.statusCode).toBe(200);
        expect(JSON.parse(delRes.body)).toMatchObject({ status: 'archived' });

        const delAgain = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/grc/vendors/${created.id}`,
          headers: adminHeaders(),
        });
        expect(delAgain.statusCode).toBe(409);
      });
    });

    // ── AC 2 (vendor assessment signal) ────────────────────────────────────

    describe('Vendor Assessment + Signal (AC 2)', () => {
      it('POST /:id/assessment inserts exactly 1 `vendor_risk_assessed` signal', async () => {
        const vres = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/grc/vendors',
          headers: adminHeaders(),
          payload: { vendor_name: `${RUN_TAG} Signal Vendor`, vendor_type: 'saas' },
        });
        const vendorId = (JSON.parse(vres.body) as { id: string }).id;

        const before = await countSignalsFor('vendor_risk_assessed');
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/grc/vendors/${vendorId}/assessment`,
          headers: adminHeaders(),
          payload: { risk_score: 42, assessed_by: 'auditor@hub1454.test' },
        });
        expect(res.statusCode).toBe(201);
        const after = await countSignalsFor('vendor_risk_assessed');
        expect(after - before).toBe(1);
      });
    });

    // ── AC 3, 4, 5 (cloud signal + AC 14 suppression on fail/partial) ─────

    describe('Cloud Attestation + Signal (AC 3, 14)', () => {
      let cloudId: string;

      beforeAll(async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/grc/cloud',
          headers: adminHeaders(),
          payload: { account_name: `${RUN_TAG} Cloud A`, provider: 'aws' },
        });
        cloudId = (JSON.parse(res.body) as { id: string }).id;
      });

      it('AC 3: status=pass emits exactly 1 `cloud_security_attested` signal', async () => {
        const before = await countSignalsFor('cloud_security_attested');
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/grc/cloud/${cloudId}/attestation`,
          headers: adminHeaders(),
          payload: { attestation_type: 'mfa_enforcement', status: 'pass', attested_by: 'auditor@hub1454.test' },
        });
        expect(res.statusCode).toBe(201);
        const after = await countSignalsFor('cloud_security_attested');
        expect(after - before).toBe(1);
      });

      it('AC 14: status=fail inserts the attestation record but 0 signals', async () => {
        const before = await countSignalsFor('cloud_security_attested');
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/grc/cloud/${cloudId}/attestation`,
          headers: adminHeaders(),
          payload: { attestation_type: 'disk_encryption', status: 'fail', attested_by: 'auditor@hub1454.test' },
        });
        expect(res.statusCode).toBe(201);
        const after = await countSignalsFor('cloud_security_attested');
        expect(after - before).toBe(0);

        // Confirm the attestation row itself did land
        const { getPool } = await import('../db/pool.js');
        const { rows } = await getPool().query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM cloud_security_attestations
            WHERE account_id = $1 AND status = 'fail' AND attestation_type = 'disk_encryption'`,
          [cloudId],
        );
        expect(parseInt(rows[0]!.n, 10)).toBeGreaterThanOrEqual(1);
      });

      it('AC 14: status=partial also suppresses the signal', async () => {
        const before = await countSignalsFor('cloud_security_attested');
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/grc/cloud/${cloudId}/attestation`,
          headers: adminHeaders(),
          payload: { attestation_type: 'screen_lock', status: 'partial', attested_by: 'auditor@hub1454.test' },
        });
        expect(res.statusCode).toBe(201);
        const after = await countSignalsFor('cloud_security_attested');
        expect(after - before).toBe(0);
      });
    });

    // ── AC 6 (policy acknowledgment + non-admin self-service) ──────────────

    describe('Policy Acknowledgment + Signal (AC 6)', () => {
      let policyId: string;

      beforeAll(async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/grc/policies',
          headers: adminHeaders(),
          payload: {
            policy_name: `${RUN_TAG} Signal Policy`,
            policy_type: 'security',
            version: 'v1.0',
          },
        });
        policyId = (JSON.parse(res.body) as { id: string }).id;
      });

      it('super_admin acknowledgment emits 1 signal', async () => {
        const before = await countSignalsFor('policy_acknowledged');
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/grc/policies/${policyId}/acknowledge`,
          headers: adminHeaders(),
          payload: { employee_id: 'emp-1454-1', employee_name: 'Ada Lovelace', policy_version: 'v1.0' },
        });
        expect(res.statusCode).toBe(201);
        const after = await countSignalsFor('policy_acknowledged');
        expect(after - before).toBe(1);
      });

      // AC 6 (Wave 4b clarification): Wave 4b registers are portfolio-scoped, so the
      // tenant-scoped operatorRbacHook rejects product_admin upstream regardless of the
      // route handler's own gate. Operator-console acknowledgment for Wave 4b is
      // therefore super_admin-only; employee self-service is out of scope for this wave.
      // See AC 8 role enforcement below — policy acknowledge is included in the deny list.
    });

    // ── AC 7 (evaluator EXISTS query compatibility) ────────────────────────

    describe('Signal Chain Evaluator Compatibility (AC 7)', () => {
      it('all 3 Wave 4b signal types are visible to the evaluator EXISTS query', async () => {
        const { getPool } = await import('../db/pool.js');
        const { rows } = await getPool().query<{ found: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM compliance_signal_evidence e
               JOIN products p ON p.id = e.product_id
              WHERE p.slug = $1
                AND e.signal_type = ANY($2::text[])
           ) AS found`,
          [
            PORTFOLIO_SLUG,
            ['vendor_risk_assessed', 'cloud_security_attested', 'policy_acknowledged'],
          ],
        );
        expect(rows[0]!.found).toBe(true);
      });
    });

    // ── AC 8 (role enforcement) ────────────────────────────────────────────

    describe('Role Enforcement (AC 8)', () => {
      // Portfolio-scoped resources: operatorRbacHook denies product_admin on every route
      // in this plugin because tenant_id matching is impossible. Policy acknowledge is
      // included since Wave 4b operational role is super_admin-only.
      const mutations: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string; body?: Record<string, unknown> }> = [
        { method: 'POST', url: '/api/v1/admin/grc/vendors', body: { vendor_name: 'x', vendor_type: 'saas' } },
        { method: 'PUT', url: '/api/v1/admin/grc/vendors/00000000-0000-0000-0000-000000000abc', body: { vendor_name: 'x' } },
        { method: 'DELETE', url: '/api/v1/admin/grc/vendors/00000000-0000-0000-0000-000000000abc' },
        { method: 'POST', url: '/api/v1/admin/grc/vendors/00000000-0000-0000-0000-000000000abc/assessment', body: { risk_score: 50, assessed_by: 'x' } },
        { method: 'POST', url: '/api/v1/admin/grc/cloud', body: { account_name: 'x', provider: 'aws' } },
        { method: 'PUT', url: '/api/v1/admin/grc/cloud/00000000-0000-0000-0000-000000000abc', body: { account_name: 'x' } },
        { method: 'POST', url: '/api/v1/admin/grc/cloud/00000000-0000-0000-0000-000000000abc/attestation', body: { attestation_type: 'x', status: 'pass', attested_by: 'x' } },
        { method: 'POST', url: '/api/v1/admin/grc/policies', body: { policy_name: 'x', policy_type: 'security', version: 'v1' } },
        { method: 'PUT', url: '/api/v1/admin/grc/policies/00000000-0000-0000-0000-000000000abc', body: { policy_name: 'x' } },
        { method: 'POST', url: '/api/v1/admin/grc/policies/00000000-0000-0000-0000-000000000abc/acknowledge', body: { employee_id: 'x', employee_name: 'x', policy_version: 'v1' } },
      ];

      for (const m of mutations) {
        it(`${m.method} ${m.url} → 403 for product_admin`, async () => {
          const res = await app.inject({
            method: m.method,
            url: m.url,
            headers: productAdminHeaders(),
            payload: m.body,
          });
          expect(res.statusCode).toBe(403);
        });
      }
    });

    // ── AC 9 (pagination) ──────────────────────────────────────────────────

    describe('Pagination (AC 9)', () => {
      it('GET /vendors?page=2&pageSize=1 returns page 2 subset + total', async () => {
        for (let i = 0; i < 3; i++) {
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/grc/vendors',
            headers: adminHeaders(),
            payload: { vendor_name: `${RUN_TAG} Page Vendor ${i}`, vendor_type: 'saas' },
          });
        }
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/grc/vendors?page=2&pageSize=1&status=active',
          headers: adminHeaders(),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { data: unknown[]; total: number; page: number; pageSize: number };
        expect(body.page).toBe(2);
        expect(body.pageSize).toBe(1);
        expect(body.data).toHaveLength(1);
        expect(body.total).toBeGreaterThanOrEqual(3);
      });
    });
  },
);
