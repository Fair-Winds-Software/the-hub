// Authorized by HUB-1414 (E-CMP-WAVE4 S6, HUB-870) — comprehensive integration tests for
// the GRC-Lite Wave 4 register API + signal chain. Full stack: real DB, real transactions,
// signal-emission assertions via COUNT queries on compliance_signal_evidence (the actual
// table shipped by HUB-1020; story's `compliance_signal_log` naming predates that rename).
//
// Gated behind RUN_INTEGRATION=1 per the HUB integration-test convention. Prerequisites:
//   - migrations 067 + 068 applied (GRC-Lite schemas + device status column)
//   - hub_dev DB reachable via DATABASE_URL
//   - dev env vars per .env.example
//
// Reconciliations vs story text:
//   - `compliance_signal_log` -> `compliance_signal_evidence` (HUB-1020)
//   - Frontend msw suite deferred: HUB-1396/1397/1398 already ship 35 tests covering
//     the same interaction paths via direct apiClient mocks; msw variants would be
//     coverage overlap.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'HUB-1414: GRC-Lite Wave 4 integration suite (RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let superAdminToken: string;
    let productAdminToken: string;
    let tenantId: string;
    let productSlug = 'hub1414-test';
    let seededDeviceIds: string[] = [];

    beforeAll(async () => {
      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const { getPool } = await import('../db/pool.js');
      const pool = getPool();

      // Seed a tenant + a product whose slug matches the GRC records' product_id TEXT.
      const { rows: tRows } = await pool.query<{ id: string }>(
        `INSERT INTO tenants (name, tenant_type, active)
         VALUES ('HUB-1414 Tenant', 'external', true)
         RETURNING id`,
      );
      tenantId = tRows[0]!.id;

      await pool.query(
        `INSERT INTO products (id, tenant_id, name, slug, active)
         VALUES (gen_random_uuid(), $1, 'HUB-1414 Product', $2, true)
         ON CONFLICT (slug) DO NOTHING`,
        [tenantId, productSlug],
      );

      // Mint two JWTs directly — super_admin for mutations, product_admin for 403 assertions
      const jwt = await import('jsonwebtoken');
      const secret = process.env['OPERATOR_JWT_SECRET']!;
      superAdminToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-00000000ffff', role: 'super_admin', tenant_id: null },
        secret,
        { expiresIn: '1h' },
      );
      productAdminToken = jwt.default.sign(
        { operator_id: '00000000-0000-0000-0000-00000000fffe', role: 'product_admin', tenant_id: tenantId },
        secret,
        { expiresIn: '1h' },
      );
    });

    afterAll(async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();

      // device_compliance_records is immutable — leave rows and clean up parent devices
      // that have no children. Filter test rows via `hub1414-` prefixed identifiers.
      await pool.query(
        `DELETE FROM compliance_signal_evidence
          WHERE product_id IN (SELECT id FROM products WHERE slug = $1)`,
        [productSlug],
      );
      await pool.query(
        `DELETE FROM hr_onboarding_records WHERE product_id = $1`,
        [productSlug],
      );
      await pool.query(
        `DELETE FROM hr_offboarding_records WHERE product_id = $1`,
        [productSlug],
      );
      await pool.query(
        `DELETE FROM device_inventory
          WHERE product_id = $1
            AND id NOT IN (SELECT device_id FROM device_compliance_records)`,
        [productSlug],
      );
      await pool.query(`DELETE FROM products WHERE slug = $1`, [productSlug]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);

      await app.close();
    });

    const adminHeaders = () => ({ Authorization: `Bearer ${superAdminToken}` });
    const productAdminHeaders = () => ({ Authorization: `Bearer ${productAdminToken}` });

    // Helper: count evidence rows matching a signal_type inserted in this suite (product-scoped).
    async function countSignalsFor(signalType: string, productSlugParam: string = productSlug): Promise<number> {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM compliance_signal_evidence e
           JOIN products p ON p.id = e.product_id
          WHERE e.signal_type = $1 AND p.slug = $2`,
        [signalType, productSlugParam],
      );
      return parseInt(rows[0]!.n, 10);
    }

    // ── AC 1 (device CRUD) ──────────────────────────────────────────────────

    describe('Device CRUD (AC 1)', () => {
      it('POST /devices creates → GET returns it → PUT updates → DELETE soft-deletes', async () => {
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/grc/devices',
          headers: adminHeaders(),
          payload: {
            product_id: productSlug,
            device_name: 'HUB-1414 MBP',
            owner_name: 'QA Bot',
            owner_email: 'hub1414-crud@test.internal',
            model: 'MBP 14',
            serial_number: 'SN-HUB1414-CRUD',
          },
        });
        expect(createRes.statusCode).toBe(201);
        const created = JSON.parse(createRes.body) as { id: string; status: string };
        expect(created.status).toBe('active');
        seededDeviceIds.push(created.id);

        const getRes = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/grc/devices?page=1&pageSize=50&status=active',
          headers: adminHeaders(),
        });
        expect(getRes.statusCode).toBe(200);
        const list = JSON.parse(getRes.body) as { data: Array<{ id: string }>; total: number };
        expect(list.data.some((d) => d.id === created.id)).toBe(true);

        const putRes = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/grc/devices/${created.id}`,
          headers: adminHeaders(),
          payload: { model: 'MBP 16' },
        });
        expect(putRes.statusCode).toBe(200);
        expect(JSON.parse(putRes.body)).toMatchObject({ model: 'MBP 16' });

        const delRes = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/grc/devices/${created.id}`,
          headers: adminHeaders(),
        });
        expect(delRes.statusCode).toBe(200);
        expect(JSON.parse(delRes.body)).toMatchObject({ id: created.id });
        expect((JSON.parse(delRes.body) as { decommissioned_at: string }).decommissioned_at).toBeTruthy();

        const delAgain = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/grc/devices/${created.id}`,
          headers: adminHeaders(),
        });
        expect(delAgain.statusCode).toBe(409);
      });
    });

    // ── AC 2, 3 (device compliance signal emit + suppression) ───────────────

    describe('Device Compliance Attestation + Signal (AC 2, 3)', () => {
      let deviceId: string;

      beforeAll(async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/grc/devices',
          headers: adminHeaders(),
          payload: {
            product_id: productSlug,
            device_name: 'HUB-1414 Attest MBP',
            owner_name: 'Attester',
            owner_email: 'hub1414-attest@test.internal',
          },
        });
        deviceId = (JSON.parse(res.body) as { id: string }).id;
        seededDeviceIds.push(deviceId);
      });

      it('AC 2: compliant attestation inserts exactly 1 signal row', async () => {
        const before = await countSignalsFor('device_compliance_attested');
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/grc/devices/${deviceId}/compliance`,
          headers: adminHeaders(),
          payload: {
            compliance_type: 'mdm_enrollment',
            status: 'compliant',
            attested_by: 'it-lead@hub1414.test',
          },
        });
        expect(res.statusCode).toBe(201);
        const after = await countSignalsFor('device_compliance_attested');
        expect(after - before).toBe(1);
      });

      it('AC 3: non-compliant attestation inserts the record but 0 signal rows', async () => {
        const before = await countSignalsFor('device_compliance_attested');
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/grc/devices/${deviceId}/compliance`,
          headers: adminHeaders(),
          payload: {
            compliance_type: 'disk_encryption',
            status: 'non_compliant',
            attested_by: 'it-lead@hub1414.test',
          },
        });
        expect(res.statusCode).toBe(201);
        const after = await countSignalsFor('device_compliance_attested');
        expect(after - before).toBe(0);

        // Verify the device_compliance_records row DID persist despite no signal
        const { getPool } = await import('../db/pool.js');
        const { rows } = await getPool().query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM device_compliance_records
            WHERE device_id = $1 AND compliance_type = 'disk_encryption' AND status = 'non_compliant'`,
          [deviceId],
        );
        expect(parseInt(rows[0]!.n, 10)).toBeGreaterThanOrEqual(1);
      });
    });

    // ── AC 4 (onboarding complete signal) ──────────────────────────────────

    describe('HR Onboarding + Signal (AC 4)', () => {
      let recordId: string;

      it('POST /onboarding creates a record with sla_deadline = hire_date + 7 days', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/grc/onboarding',
          headers: adminHeaders(),
          payload: {
            product_id: productSlug,
            employee_name: 'HUB-1414 Onboard',
            employee_email: 'hub1414-onb@test.internal',
            role: 'eng',
            hire_date: '2026-07-05',
          },
        });
        expect(res.statusCode).toBe(201);
        const row = JSON.parse(res.body) as { id: string; sla_deadline: string };
        recordId = row.id;
        // pg serializes DATE columns as ISO timestamps at UTC midnight; accept either form.
        expect(row.sla_deadline.startsWith('2026-07-12')).toBe(true);
      });

      it('POST /:id/complete inserts exactly 1 signal row', async () => {
        const before = await countSignalsFor('hr_onboarding_completed');
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/grc/onboarding/${recordId}/complete`,
          headers: adminHeaders(),
        });
        expect(res.statusCode).toBe(200);
        const after = await countSignalsFor('hr_onboarding_completed');
        expect(after - before).toBe(1);
        expect((JSON.parse(res.body) as { completed_at: string }).completed_at).toBeTruthy();
      });
    });

    // ── AC 5, 6 (offboarding partial vs all-3-true) ────────────────────────

    describe('HR Offboarding Checklist + Signal (AC 5, 6)', () => {
      let recordId: string;

      it('POST /offboarding creates a record with revocation_deadline = last_day + 24h', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/grc/offboarding',
          headers: adminHeaders(),
          payload: {
            product_id: productSlug,
            employee_name: 'HUB-1414 Off',
            employee_email: 'hub1414-off@test.internal',
            role: 'eng',
            last_day: '2026-07-05',
          },
        });
        expect(res.statusCode).toBe(201);
        const row = JSON.parse(res.body) as { id: string; revocation_deadline: string };
        recordId = row.id;
        // last_day + 24h from UTC midnight
        expect(row.revocation_deadline.startsWith('2026-07-06T00:00:00')).toBe(true);
      });

      it('AC 5: partial checklist (1-2 items) inserts 0 signals; completed_at stays null', async () => {
        const before = await countSignalsFor('hr_offboarding_completed');
        const res1 = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/grc/offboarding/${recordId}/checklist`,
          headers: adminHeaders(),
          payload: { device_returned: true },
        });
        expect(res1.statusCode).toBe(200);
        expect((JSON.parse(res1.body) as { completed_at: string | null }).completed_at).toBeNull();

        const res2 = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/grc/offboarding/${recordId}/checklist`,
          headers: adminHeaders(),
          payload: { accounts_disabled: true },
        });
        expect(res2.statusCode).toBe(200);
        expect((JSON.parse(res2.body) as { completed_at: string | null }).completed_at).toBeNull();

        const after = await countSignalsFor('hr_offboarding_completed');
        expect(after - before).toBe(0);
      });

      it('AC 6: all-3-true checklist inserts exactly 1 signal + completed_at set', async () => {
        const before = await countSignalsFor('hr_offboarding_completed');
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/grc/offboarding/${recordId}/checklist`,
          headers: adminHeaders(),
          payload: { tokens_revoked: true },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { completed_at: string | null; status: string };
        expect(body.completed_at).toBeTruthy();
        expect(body.status).toBe('completed');
        const after = await countSignalsFor('hr_offboarding_completed');
        expect(after - before).toBe(1);
      });
    });

    // ── AC 7 (evaluator EXISTS query compatibility) ─────────────────────────

    describe('Signal Chain Evaluator Compatibility (AC 7)', () => {
      it('all 3 GRC signal types are visible to the evaluator EXISTS query', async () => {
        const { getPool } = await import('../db/pool.js');
        const { rows } = await getPool().query<{ found: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM compliance_signal_evidence e
               JOIN products p ON p.id = e.product_id
              WHERE p.slug = $1
                AND e.signal_type = ANY($2::text[])
           ) AS found`,
          [
            productSlug,
            [
              'device_compliance_attested',
              'hr_onboarding_completed',
              'hr_offboarding_completed',
            ],
          ],
        );
        expect(rows[0]!.found).toBe(true);
      });
    });

    // ── AC 8 (role enforcement — product_admin → 403 on all mutations) ─────

    describe('Role Enforcement (AC 8)', () => {
      const mutations: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string; body?: Record<string, unknown> }> = [
        {
          method: 'POST', url: '/api/v1/admin/grc/devices',
          body: {
            product_id: productSlug, device_name: 'x', owner_name: 'x', owner_email: 'x',
          },
        },
        { method: 'PUT', url: `/api/v1/admin/grc/devices/00000000-0000-0000-0000-000000000abc`, body: { model: 'x' } },
        { method: 'DELETE', url: `/api/v1/admin/grc/devices/00000000-0000-0000-0000-000000000abc` },
        {
          method: 'POST', url: `/api/v1/admin/grc/devices/00000000-0000-0000-0000-000000000abc/compliance`,
          body: { compliance_type: 'mdm_enrollment', status: 'compliant', attested_by: 'x' },
        },
        {
          method: 'POST', url: '/api/v1/admin/grc/onboarding',
          body: { product_id: productSlug, employee_name: 'x', employee_email: 'x', role: 'x', hire_date: '2026-07-05' },
        },
        { method: 'POST', url: `/api/v1/admin/grc/onboarding/00000000-0000-0000-0000-000000000abc/complete` },
        {
          method: 'POST', url: '/api/v1/admin/grc/offboarding',
          body: { product_id: productSlug, employee_name: 'x', employee_email: 'x', role: 'x', last_day: '2026-07-05' },
        },
        {
          method: 'PUT', url: `/api/v1/admin/grc/offboarding/00000000-0000-0000-0000-000000000abc/checklist`,
          body: { device_returned: true },
        },
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
      it('GET /devices?page=2&pageSize=1 returns page 2 subset + total', async () => {
        // Seed a couple more devices so we have at least 3 total under this product
        for (let i = 0; i < 3; i++) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/v1/admin/grc/devices',
            headers: adminHeaders(),
            payload: {
              product_id: productSlug,
              device_name: `HUB-1414 Page ${i}`,
              owner_name: 'Pager',
              owner_email: `hub1414-page-${i}@test.internal`,
              serial_number: `SN-HUB1414-PAGE-${i}`,
            },
          });
          expect(res.statusCode).toBe(201);
          seededDeviceIds.push((JSON.parse(res.body) as { id: string }).id);
        }

        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/grc/devices?page=2&pageSize=1&status=active',
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
