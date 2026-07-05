// Authorized by HUB-1384 (E-CMP-WAVE4 S1, HUB-870) — migration 067 schema tests:
// table + column shapes, CHECK constraints, immutability trigger (SQLSTATE 23514),
// content_hash trigger + UNIQUE dedup, seeded 5 GRC controls, 'quarterly' cadence
// accepted after CHECK widening.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  SIGNAL_DEVICE_COMPLIANCE_ATTESTED,
  SIGNAL_HR_ONBOARDING_COMPLETED,
  SIGNAL_HR_OFFBOARDING_COMPLETED,
  GRC_WAVE4_SIGNAL_TYPES,
} from '../../compliance/signalTypes.js';

const CONNECTION_STRING = process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';

let client: Client;

// device_compliance_records is immutable (BEFORE UPDATE OR DELETE trigger) AND
// FK-referenced from device_inventory. Cleanup therefore only deletes device_inventory
// rows that have no dangling compliance records; the immutable rows themselves stay
// (which is exactly correct for audit history). Re-running the suite generates fresh
// UUID device_ids so content_hash never collides across runs.
async function cleanupTestRows(c: Client): Promise<void> {
  await c.query(`DELETE FROM hr_onboarding_records WHERE employee_email LIKE 'hub1384-%@test.internal'`);
  await c.query(`DELETE FROM hr_offboarding_records WHERE employee_email LIKE 'hub1384-%@test.internal'`);
  await c.query(
    `DELETE FROM device_inventory
      WHERE owner_email LIKE 'hub1384-%@test.internal'
        AND id NOT IN (SELECT device_id FROM device_compliance_records)`,
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  await cleanupTestRows(client);
});

afterAll(async () => {
  await cleanupTestRows(client);
  await client.end();
});

// ── AC 1-4: schema shapes ─────────────────────────────────────────────────────

describe('device_inventory schema (AC 1)', () => {
  it('table exists with expected columns + nullability', async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'device_inventory'
       ORDER BY ordinal_position`,
    );
    const cols = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(cols).toHaveProperty('id');
    expect(cols).toHaveProperty('product_id');
    expect(cols.product_id?.is_nullable).toBe('NO');
    expect(cols).toHaveProperty('device_name');
    expect(cols).toHaveProperty('owner_name');
    expect(cols).toHaveProperty('owner_email');
    expect(cols).toHaveProperty('model');
    expect(cols.model?.is_nullable).toBe('YES');
    expect(cols).toHaveProperty('serial_number');
    expect(cols).toHaveProperty('enrollment_date');
    expect(cols).toHaveProperty('added_at');
    expect(cols).toHaveProperty('updated_at');
    expect(cols).toHaveProperty('delta_data');
  });

  it('UNIQUE (product_id, serial_number) is enforced', async () => {
    await client.query(
      `INSERT INTO device_inventory (product_id, device_name, owner_name, owner_email, serial_number)
       VALUES ('contenthelm', 'MBP-1', 'Ada', 'hub1384-uniq@test.internal', 'SN-UNIQ-1')`,
    );
    const err = await client
      .query(
        `INSERT INTO device_inventory (product_id, device_name, owner_name, owner_email, serial_number)
         VALUES ('contenthelm', 'MBP-2', 'Ada2', 'hub1384-uniq2@test.internal', 'SN-UNIQ-1')`,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23505');
  });
});

describe('device_compliance_records schema (AC 2)', () => {
  it('table exists with expected columns', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'device_compliance_records'
       ORDER BY ordinal_position`,
    );
    const names = rows.map((r) => r.column_name);
    expect(names).toEqual(
      expect.arrayContaining(['id', 'device_id', 'compliance_type', 'status', 'attested_by', 'attested_at', 'content_hash']),
    );
  });

  it('CHECK on compliance_type rejects unknown values', async () => {
    const dev = await client.query<{ id: string }>(
      `INSERT INTO device_inventory (product_id, device_name, owner_name, owner_email)
       VALUES ('hub', 'MBP-Check', 'Bob', 'hub1384-check@test.internal') RETURNING id`,
    );
    const deviceId = dev.rows[0]!.id;
    const err = await client
      .query(
        `INSERT INTO device_compliance_records (device_id, compliance_type, status, attested_by)
         VALUES ($1, 'bogus', 'compliant', 'auditor@example.com')`,
        [deviceId],
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23514');
  });

  it('content_hash trigger populates SHA-256 automatically on INSERT', async () => {
    const dev = await client.query<{ id: string }>(
      `INSERT INTO device_inventory (product_id, device_name, owner_name, owner_email)
       VALUES ('hub', 'MBP-Hash', 'Carol', 'hub1384-hash@test.internal') RETURNING id`,
    );
    const deviceId = dev.rows[0]!.id;
    const { rows } = await client.query<{ content_hash: string }>(
      `INSERT INTO device_compliance_records (device_id, compliance_type, status, attested_by)
       VALUES ($1, 'mdm_enrollment', 'compliant', 'it-lead@example.com')
       RETURNING content_hash`,
      [deviceId],
    );
    expect(rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('immutability trigger rejects UPDATE with SQLSTATE 23514', async () => {
    const dev = await client.query<{ id: string }>(
      `INSERT INTO device_inventory (product_id, device_name, owner_name, owner_email)
       VALUES ('hub', 'MBP-Imm', 'Dan', 'hub1384-imm@test.internal') RETURNING id`,
    );
    const deviceId = dev.rows[0]!.id;
    const rec = await client.query<{ id: string }>(
      `INSERT INTO device_compliance_records (device_id, compliance_type, status, attested_by)
       VALUES ($1, 'screen_lock', 'compliant', 'it-lead@example.com') RETURNING id`,
      [deviceId],
    );
    const recordId = rec.rows[0]!.id;

    const updErr = await client
      .query(`UPDATE device_compliance_records SET status = 'non_compliant' WHERE id = $1`, [recordId])
      .catch((e) => e);
    expect(updErr).toBeInstanceOf(Error);
    expect((updErr as NodeJS.ErrnoException & { code: string }).code).toBe('23514');

    const delErr = await client
      .query(`DELETE FROM device_compliance_records WHERE id = $1`, [recordId])
      .catch((e) => e);
    expect(delErr).toBeInstanceOf(Error);
    expect((delErr as NodeJS.ErrnoException & { code: string }).code).toBe('23514');
  });

  it('duplicate content_hash raises UNIQUE (23505) — proves the trigger uses the same inputs', async () => {
    const dev = await client.query<{ id: string }>(
      `INSERT INTO device_inventory (product_id, device_name, owner_name, owner_email)
       VALUES ('hub', 'MBP-Dup', 'Eve', 'hub1384-dup@test.internal') RETURNING id`,
    );
    const deviceId = dev.rows[0]!.id;
    // Pin attested_at to the same instant so the two inserts hash to the same content_hash.
    const attestedAt = '2026-07-05T12:00:00Z';
    await client.query(
      `INSERT INTO device_compliance_records (device_id, compliance_type, status, attested_by, attested_at)
       VALUES ($1, 'disk_encryption', 'compliant', 'it-lead@example.com', $2)`,
      [deviceId, attestedAt],
    );
    const err = await client
      .query(
        `INSERT INTO device_compliance_records (device_id, compliance_type, status, attested_by, attested_at)
         VALUES ($1, 'disk_encryption', 'compliant', 'it-lead@example.com', $2)`,
        [deviceId, attestedAt],
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23505');
  });
});

describe('hr_onboarding_records schema (AC 3)', () => {
  it('table exists with expected columns + defaults', async () => {
    const { rows } = await client.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
      `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'hr_onboarding_records'
       ORDER BY ordinal_position`,
    );
    const cols = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(cols.status?.column_default).toContain('pending');
    expect(cols.attested_by?.is_nullable).toBe('YES');
    expect(cols.completed_at?.is_nullable).toBe('YES');
  });

  it('CHECK (completed_at IS NULL OR status = completed) rejects mismatched pair', async () => {
    const err = await client
      .query(
        `INSERT INTO hr_onboarding_records
           (product_id, employee_name, employee_email, role, hire_date, sla_deadline,
            status, completed_at)
         VALUES ('hub', 'FailedOnb', 'hub1384-onb-fail@test.internal', 'eng',
                 '2026-07-01', '2026-07-08', 'pending', '2026-07-05T12:00:00Z')`,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23514');
  });

  it('accepts a valid completed row', async () => {
    await expect(
      client.query(
        `INSERT INTO hr_onboarding_records
           (product_id, employee_name, employee_email, role, hire_date, sla_deadline,
            status, attested_by, completed_at)
         VALUES ('hub', 'GoodOnb', 'hub1384-onb-ok@test.internal', 'eng',
                 '2026-07-01', '2026-07-08', 'completed', 'hr-lead@example.com', '2026-07-05T12:00:00Z')`,
      ),
    ).resolves.toBeTruthy();
  });
});

describe('hr_offboarding_records schema (AC 4)', () => {
  it('CHECK (completed requires all three revocations) rejects incomplete', async () => {
    const err = await client
      .query(
        `INSERT INTO hr_offboarding_records
           (product_id, employee_name, employee_email, role, last_day, revocation_deadline,
            device_returned, accounts_disabled, tokens_revoked,
            status, completed_at)
         VALUES ('hub', 'FailedOff', 'hub1384-off-fail@test.internal', 'eng',
                 '2026-07-01', '2026-07-02T12:00:00Z',
                 true, true, false,
                 'completed', '2026-07-02T13:00:00Z')`,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23514');
  });

  it('accepts a fully-revoked completed row', async () => {
    await expect(
      client.query(
        `INSERT INTO hr_offboarding_records
           (product_id, employee_name, employee_email, role, last_day, revocation_deadline,
            device_returned, accounts_disabled, tokens_revoked,
            status, completed_at)
         VALUES ('hub', 'GoodOff', 'hub1384-off-ok@test.internal', 'eng',
                 '2026-07-01', '2026-07-02T12:00:00Z',
                 true, true, true,
                 'completed', '2026-07-02T11:00:00Z')`,
      ),
    ).resolves.toBeTruthy();
  });
});

// ── AC 5: seeded 5 GRC controls ──────────────────────────────────────────────

describe('compliance_controls GRC-Lite Wave 4 seeds (AC 5)', () => {
  it('all 5 GRC control_ids are present with control_class=human', async () => {
    const { rows } = await client.query<{ control_id: string; control_class: string; eval_cadence: string; tsc_category: string }>(
      `SELECT control_id, control_class, eval_cadence, tsc_category
         FROM compliance_controls
        WHERE control_id IN (
          'device-mdm-compliance', 'device-disk-encryption', 'device-screen-lock',
          'hr-onboarding-sla', 'hr-offboarding-24h'
        )`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.control_id, r]));
    expect(byId['device-mdm-compliance']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'monthly', tsc_category: 'CC6.7' }),
    );
    expect(byId['device-disk-encryption']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'quarterly', tsc_category: 'CC6.7' }),
    );
    expect(byId['device-screen-lock']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'monthly', tsc_category: 'CC6.7' }),
    );
    expect(byId['hr-onboarding-sla']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'weekly', tsc_category: 'CC1.4' }),
    );
    expect(byId['hr-offboarding-24h']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'daily', tsc_category: 'CC6.3' }),
    );
  });

  it('eval_cadence CHECK now accepts quarterly (widened by migration 067)', async () => {
    const { rows } = await client.query<{ cadence: string }>(
      `SELECT eval_cadence AS cadence FROM compliance_controls WHERE control_id = 'device-disk-encryption'`,
    );
    expect(rows[0]?.cadence).toBe('quarterly');
  });
});

// ── AC 6: signal types module ────────────────────────────────────────────────

describe('signalTypes module (AC 6)', () => {
  it('exports the three GRC-Lite Wave 4 signal type constants', () => {
    expect(SIGNAL_DEVICE_COMPLIANCE_ATTESTED).toBe('device_compliance_attested');
    expect(SIGNAL_HR_ONBOARDING_COMPLETED).toBe('hr_onboarding_completed');
    expect(SIGNAL_HR_OFFBOARDING_COMPLETED).toBe('hr_offboarding_completed');
    expect(GRC_WAVE4_SIGNAL_TYPES).toHaveLength(3);
  });
});

// ── AC 8: migration idempotency ──────────────────────────────────────────────

describe('migration 067 idempotency (AC 8)', () => {
  it('re-running the seed INSERT does not fail and does not duplicate rows', async () => {
    await client.query(
      `INSERT INTO compliance_controls (control_id, name, description, tsc_category, control_class, eval_cadence, active)
       VALUES
         ('device-mdm-compliance', 'x', 'x', 'CC6.7', 'human', 'monthly', true),
         ('device-disk-encryption', 'x', 'x', 'CC6.7', 'human', 'quarterly', true)
       ON CONFLICT (control_id) DO NOTHING`,
    );
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM compliance_controls WHERE control_id = 'device-mdm-compliance'`,
    );
    expect(rows[0]!.n).toBe('1');
  });

  // NOTE: intentionally NOT asserting on schema_migrations here. migrate.integration.test.ts
  // drops+repopulates schema_migrations in its beforeEach/afterAll cycle (HUB-1709), so
  // this test's view of that table is race-dependent when run in the same vitest session.
  // The actual "migration was applied" evidence is the 16 other tests above that exercise
  // the created tables + triggers + seeded controls directly.
});
