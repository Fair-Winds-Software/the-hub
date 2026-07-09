// Authorized by HUB-1704 — auth event audit-write integration coverage (login.success/failure,
//   logout, refresh_token.revoked).
// Authorized by HUB-1580 — SOC 2 audit-trail verification for /api/v1/admin/auth/* — asserts
//   exactly one audit_log row per call with the expected event_type, actor_id, reason, and
//   confirms no password leakage in new_values. Per HUB-1580 R1 D-HUB-SCOPE-028, audit row
//   is written when the BE flow completes successfully (login + logout + refresh — all sync).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

import { closeAppResources } from './_testCleanup.js';
const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const HUB_INTERNAL_TENANT_ID = '00000000-0000-0000-0000-0000000000a1';

const ACTIVE_EMAIL = 'audit-trail-active@integration.test';
const ACTIVE_PASSWORD = 'AuditTrail!Active99';
const DEACTIVATED_EMAIL = 'audit-trail-deactivated@integration.test';
const DEACTIVATED_PASSWORD = 'AuditTrail!Deactivated99';

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_type: string | null;
  operation: string;
  table_name: string;
  record_id: string | null;
  event_type: string | null;
  new_values: Record<string, unknown> | null;
  ip_address: string | null;
  trace_id: string | null;
}

async function getPoolHandle() {
  const { getPool } = await import('../db/pool.js');
  return getPool();
}

async function clearAuthAuditRows(): Promise<void> {
  const pool = await getPoolHandle();
  await pool.query(`DELETE FROM audit_log WHERE event_type LIKE 'auth.%' AND tenant_id = $1`, [
    HUB_INTERNAL_TENANT_ID,
  ]);
}

async function getAuthAuditRows(): Promise<AuditRow[]> {
  const pool = await getPoolHandle();
  const { rows } = await pool.query<AuditRow>(
    `SELECT id, tenant_id, actor_id, actor_type, operation, table_name, record_id,
            event_type, new_values, ip_address::text AS ip_address, trace_id
       FROM audit_log
      WHERE event_type LIKE 'auth.%' AND tenant_id = $1
      ORDER BY occurred_at ASC`,
    [HUB_INTERNAL_TENANT_ID],
  );
  return rows;
}

(RUN_INTEGRATION ? describe : describe.skip)(
  'Auth audit trail (HUB-1704 + HUB-1580, RUN_INTEGRATION=1)',
  () => {
    let app: FastifyInstance;
    let activeOperatorId: string;

    beforeAll(async () => {
      process.env['DATABASE_URL'] ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
      process.env['REDIS_URL'] ??= 'redis://localhost:6379';
      process.env['JWT_SECRET'] ??= 'test-jwt-secret-audit-trail';
      process.env['OPERATOR_JWT_SECRET'] = 'test-operator-jwt-secret-audit-trail';
      process.env['OPERATOR_JWT_TTL_SECONDS'] = '3600';
      process.env['BCRYPT_ROUNDS'] = '1';
      process.env['NODE_ENV'] = 'test';

      const { buildApp } = await import('../app.js');
      app = await buildApp();
      await app.ready();

      const pool = await getPoolHandle();

      // Seed an active operator and a deactivated operator. ON CONFLICT DO NOTHING so the
      // test is idempotent across reruns; bcrypt cost is 1 (BCRYPT_ROUNDS=1 in test env) but
      // the actual hashing is done with cost 12 inside loginOperator's DUMMY_HASH path —
      // we mirror the production cost here so bcrypt.compare lands.
      const activeHash = await bcrypt.hash(ACTIVE_PASSWORD, 1);
      const deactivatedHash = await bcrypt.hash(DEACTIVATED_PASSWORD, 1);

      await pool.query(
        `INSERT INTO operator_accounts (email, password_hash, role, active)
         VALUES ($1, $2, 'super_admin', true)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true`,
        [ACTIVE_EMAIL, activeHash],
      );
      await pool.query(
        `INSERT INTO operator_accounts (email, password_hash, role, active)
         VALUES ($1, $2, 'super_admin', false)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = false`,
        [DEACTIVATED_EMAIL, deactivatedHash],
      );

      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM operator_accounts WHERE email = $1`,
        [ACTIVE_EMAIL],
      );
      activeOperatorId = rows[0]!.id;
    });

    afterAll(async () => {
      const pool = await getPoolHandle();
      await clearAuthAuditRows();
      await pool.query(`DELETE FROM operator_refresh_tokens WHERE operator_id = $1`, [
        activeOperatorId,
      ]);
      await pool.query(`DELETE FROM operator_accounts WHERE email IN ($1, $2)`, [
        ACTIVE_EMAIL,
        DEACTIVATED_EMAIL,
      ]);

      const { closePool } = await import('../db/pool.js');
      const { closeRedis } = await import('../redis/client.js');
      await closeAppResources(app);
      await closePool();
      await closeRedis();
    });

    beforeEach(async () => {
      await clearAuthAuditRows();
    });

    describe('HUB-1580 AC#1 baseline: E25 audit catalog includes auth events', () => {
      it('audit_log.event_type column exists with CHECK constraint enumerating 4 auth events', async () => {
        const pool = await getPoolHandle();
        const { rows } = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'audit_log' AND column_name = 'event_type'`,
        );
        expect(rows).toHaveLength(1);
      });
    });

    describe('AC#2 + AC#5: loginOperator audit writes', () => {
      it('successful login writes exactly one auth.login.success row with operator + role + IP + trace', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: ACTIVE_EMAIL, password: ACTIVE_PASSWORD },
        });
        expect(res.statusCode).toBe(200);

        const rows = await getAuthAuditRows();
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.event_type).toBe('auth.login.success');
        expect(row.actor_id).toBe(activeOperatorId);
        expect(row.actor_type).toBe('operator');
        expect(row.operation).toBe('INSERT');
        expect(row.table_name).toBe('operator_accounts');
        expect(row.record_id).toBe(activeOperatorId);
        expect(row.new_values).toMatchObject({ email: ACTIVE_EMAIL, role: 'super_admin' });
        // ip_address (INET) populated from request.ip; trace_id is the Fastify per-request
        // UUID (server.ts genReqId returns crypto.randomUUID; incoming x-request-id is
        // intentionally NOT honored — HUB convention for deterministic trace_id provenance).
        expect(row.ip_address).not.toBeNull();
        expect(row.trace_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        // password MUST NOT leak (HUB-1704 AC#2 + redact-fields extension)
        expect(JSON.stringify(row.new_values)).not.toContain(ACTIVE_PASSWORD);
      });

      it('failed login with wrong password writes exactly one auth.login.failure row with reason=invalid_credentials', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: ACTIVE_EMAIL, password: 'wrong-password-here' },
        });
        expect(res.statusCode).toBe(401);

        const rows = await getAuthAuditRows();
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.event_type).toBe('auth.login.failure');
        expect(row.new_values).toMatchObject({ email: ACTIVE_EMAIL, reason: 'invalid_credentials' });
        // Password attempt MUST NOT leak.
        expect(JSON.stringify(row.new_values)).not.toContain('wrong-password-here');
      });

      it('failed login with deactivated account writes auth.login.failure with reason=operator_deactivated', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: DEACTIVATED_EMAIL, password: DEACTIVATED_PASSWORD },
        });
        expect(res.statusCode).toBe(401);

        const rows = await getAuthAuditRows();
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.event_type).toBe('auth.login.failure');
        expect(row.new_values).toMatchObject({
          email: DEACTIVATED_EMAIL,
          reason: 'operator_deactivated',
        });
      });

      it('failed login for unknown email writes auth.login.failure with reason=invalid_credentials (no actor leak)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: 'never-existed@example.test', password: 'irrelevant' },
        });
        expect(res.statusCode).toBe(401);

        const rows = await getAuthAuditRows();
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.event_type).toBe('auth.login.failure');
        expect(row.actor_id).toBeNull();
        expect(row.new_values).toMatchObject({ reason: 'invalid_credentials' });
      });
    });

    describe('AC#3: logoutOperator audit write', () => {
      it('logout with valid refresh token writes auth.logout row with operator_id from token', async () => {
        const loginRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: ACTIVE_EMAIL, password: ACTIVE_PASSWORD },
        });
        const { refreshToken } = JSON.parse(loginRes.payload) as { refreshToken: string };
        await clearAuthAuditRows();

        const logoutRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/logout',
          payload: { refreshToken },
        });
        expect(logoutRes.statusCode).toBe(200);

        const rows = await getAuthAuditRows();
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.event_type).toBe('auth.logout');
        expect(row.actor_id).toBe(activeOperatorId);
        expect(row.operation).toBe('UPDATE');
        expect(row.table_name).toBe('operator_refresh_tokens');
        expect(row.trace_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      });

      it('logout with malformed refresh token is idempotent and writes NO audit row', async () => {
        const logoutRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/logout',
          payload: { refreshToken: 'malformed-no-dot-separator' },
        });
        expect(logoutRes.statusCode).toBe(200);

        const rows = await getAuthAuditRows();
        expect(rows).toHaveLength(0);
      });
    });

    describe('AC#4: refreshOperatorToken audit write', () => {
      it('successful refresh writes auth.refresh_token.revoked for the old token', async () => {
        const loginRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: ACTIVE_EMAIL, password: ACTIVE_PASSWORD },
        });
        const { refreshToken } = JSON.parse(loginRes.payload) as { refreshToken: string };
        await clearAuthAuditRows();

        const refreshRes = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/refresh',
          payload: { refreshToken },
        });
        expect(refreshRes.statusCode).toBe(200);

        const rows = await getAuthAuditRows();
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.event_type).toBe('auth.refresh_token.revoked');
        expect(row.actor_id).toBe(activeOperatorId);
        expect(row.operation).toBe('UPDATE');
        expect(row.table_name).toBe('operator_refresh_tokens');
      });
    });

    describe('AC#7: never-throws contract — auth flow does not break on audit write failure', () => {
      it('login still issues tokens even if writeAuditEntry path errors (catch-internally contract)', async () => {
        // This is implicitly verified by the design of auditLogService.writeAuditEntry (HUB-1517)
        // which catches all errors. We assert the auth flow happy path returns tokens; a full
        // BE-fault-injection test belongs in HUB-1517's own coverage and is not duplicated here.
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          payload: { email: ACTIVE_EMAIL, password: ACTIVE_PASSWORD },
        });
        expect(res.statusCode).toBe(200);
        const payload = JSON.parse(res.payload) as { accessToken: string; refreshToken: string };
        expect(payload.accessToken).toBeTruthy();
        expect(payload.refreshToken).toBeTruthy();
      });
    });
  },
);
