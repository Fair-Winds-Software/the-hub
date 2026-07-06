// Authorized by HUB-1422 (E-CMP-WAVE4b S1, HUB-871) — migration 069 schema tests.
// Verifies the 6 new tables exist, immutability triggers raise SQLSTATE 23514 on
// UPDATE/DELETE of the 3 evidence tables, content_hash BEFORE INSERT triggers produce
// 64-char hex, UNIQUE(content_hash) rejects duplicate INSERTs, the 5 new controls are
// seeded, and eval_cadence CHECK accepts 'yearly' (the new value added by 069).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  SIGNAL_VENDOR_RISK_ASSESSED,
  SIGNAL_CLOUD_SECURITY_ATTESTED,
  SIGNAL_POLICY_ACKNOWLEDGED,
  GRC_WAVE4B_SIGNAL_TYPES,
} from '../../compliance/signalTypes.js';

const CONNECTION_STRING = process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';

let client: Client;

// Immutable evidence rows survive across runs (trigger blocks DELETE). Cleanup deletes
// only mutable-register rows whose id is not referenced from any evidence child.
async function cleanupTestRows(c: Client): Promise<void> {
  await c.query(
    `DELETE FROM vendor_register
      WHERE vendor_name LIKE 'HUB1422 %'
        AND id NOT IN (SELECT vendor_id FROM vendor_risk_assessments)`,
  );
  await c.query(
    `DELETE FROM cloud_infrastructure
      WHERE account_name LIKE 'HUB1422 %'
        AND id NOT IN (SELECT account_id FROM cloud_security_attestations)`,
  );
  await c.query(
    `DELETE FROM policy_register
      WHERE policy_name LIKE 'HUB1422 %'
        AND id NOT IN (SELECT policy_id FROM policy_acknowledgments)`,
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

// ── AC 1: 6 tables exist ─────────────────────────────────────────────────────

describe('migration 069: table shapes (AC 1)', () => {
  const tables = [
    'vendor_register',
    'vendor_risk_assessments',
    'cloud_infrastructure',
    'cloud_security_attestations',
    'policy_register',
    'policy_acknowledgments',
  ];
  for (const t of tables) {
    it(`${t} table exists`, async () => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1`,
        [t],
      );
      expect(parseInt(rows[0]!.n, 10)).toBe(1);
    });
  }
});

// ── AC 2: vendor_risk_assessments immutability + content_hash ────────────────

describe('vendor_risk_assessments (AC 2)', () => {
  it('content_hash trigger populates 64-char hex on INSERT', async () => {
    const v = await client.query<{ id: string }>(
      `INSERT INTO vendor_register (vendor_name, vendor_type)
       VALUES ('HUB1422 vendor A', 'saas') RETURNING id`,
    );
    const vendorId = v.rows[0]!.id;
    const { rows } = await client.query<{ content_hash: string }>(
      `INSERT INTO vendor_risk_assessments (vendor_id, risk_score, assessed_by, findings)
       VALUES ($1, 42, 'auditor@x', 'baseline review')
       RETURNING content_hash`,
      [vendorId],
    );
    expect(rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('immutability trigger rejects UPDATE and DELETE with SQLSTATE 23514', async () => {
    const v = await client.query<{ id: string }>(
      `INSERT INTO vendor_register (vendor_name, vendor_type)
       VALUES ('HUB1422 vendor B', 'saas') RETURNING id`,
    );
    const vendorId = v.rows[0]!.id;
    const rec = await client.query<{ id: string }>(
      `INSERT INTO vendor_risk_assessments (vendor_id, risk_score, assessed_by, findings)
       VALUES ($1, 55, 'auditor@x', 'quarterly')
       RETURNING id`,
      [vendorId],
    );
    const recordId = rec.rows[0]!.id;

    const updErr = await client
      .query(`UPDATE vendor_risk_assessments SET risk_score = 99 WHERE id = $1`, [recordId])
      .catch((e) => e);
    expect((updErr as NodeJS.ErrnoException & { code: string }).code).toBe('23514');

    const delErr = await client
      .query(`DELETE FROM vendor_risk_assessments WHERE id = $1`, [recordId])
      .catch((e) => e);
    expect((delErr as NodeJS.ErrnoException & { code: string }).code).toBe('23514');
  });

  it('duplicate content_hash raises UNIQUE (23505)', async () => {
    const v = await client.query<{ id: string }>(
      `INSERT INTO vendor_register (vendor_name, vendor_type)
       VALUES ('HUB1422 vendor C', 'saas') RETURNING id`,
    );
    const vendorId = v.rows[0]!.id;
    await client.query(
      `INSERT INTO vendor_risk_assessments (vendor_id, risk_score, assessed_by, findings)
       VALUES ($1, 77, 'auditor@x', 'same tuple')`,
      [vendorId],
    );
    const err = await client
      .query(
        `INSERT INTO vendor_risk_assessments (vendor_id, risk_score, assessed_by, findings)
         VALUES ($1, 77, 'auditor@x', 'same tuple')`,
        [vendorId],
      )
      .catch((e) => e);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23505');
  });
});

// ── AC 3: cloud_security_attestations immutability + content_hash ────────────

describe('cloud_security_attestations (AC 3)', () => {
  it('content_hash + immutability + UNIQUE all enforce', async () => {
    const c = await client.query<{ id: string }>(
      `INSERT INTO cloud_infrastructure (account_name, provider)
       VALUES ('HUB1422 acct 1', 'aws') RETURNING id`,
    );
    const acctId = c.rows[0]!.id;

    const first = await client.query<{ content_hash: string; id: string }>(
      `INSERT INTO cloud_security_attestations (account_id, attestation_type, status, attested_by, findings)
       VALUES ($1, 'mfa_enforcement', 'pass', 'auditor@x', 'quarterly attestation')
       RETURNING content_hash, id`,
      [acctId],
    );
    expect(first.rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const delErr = await client
      .query(`DELETE FROM cloud_security_attestations WHERE id = $1`, [first.rows[0]!.id])
      .catch((e) => e);
    expect((delErr as NodeJS.ErrnoException & { code: string }).code).toBe('23514');

    // Findings excluded from content_hash tuple per migration 069's definition; changing
    // findings alone still produces the same content_hash → UNIQUE reject.
    const dupErr = await client
      .query(
        `INSERT INTO cloud_security_attestations (account_id, attestation_type, status, attested_by, findings)
         VALUES ($1, 'mfa_enforcement', 'pass', 'auditor@x', 'different findings')`,
        [acctId],
      )
      .catch((e) => e);
    expect((dupErr as NodeJS.ErrnoException & { code: string }).code).toBe('23505');
  });
});

// ── AC 4: policy_acknowledgments immutability + content_hash ────────────────

describe('policy_acknowledgments (AC 4)', () => {
  it('content_hash + immutability enforce', async () => {
    const p = await client.query<{ id: string }>(
      `INSERT INTO policy_register (policy_name, policy_type, version)
       VALUES ('HUB1422 policy X', 'security', 'v1.0') RETURNING id`,
    );
    const policyId = p.rows[0]!.id;

    const rec = await client.query<{ content_hash: string; id: string }>(
      `INSERT INTO policy_acknowledgments (policy_id, employee_id, employee_name, acknowledged_at, policy_version)
       VALUES ($1, 'emp-1', 'Ada Lovelace', '2026-07-05T12:00:00Z', 'v1.0')
       RETURNING content_hash, id`,
      [policyId],
    );
    expect(rec.rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const updErr = await client
      .query(`UPDATE policy_acknowledgments SET employee_name = 'renamed' WHERE id = $1`, [rec.rows[0]!.id])
      .catch((e) => e);
    expect((updErr as NodeJS.ErrnoException & { code: string }).code).toBe('23514');
  });
});

// ── AC 5: 5 GRC controls seeded ──────────────────────────────────────────────

describe('compliance_controls seeds (AC 5)', () => {
  it('all 5 GRC-Lite Wave 4b controls are present with correct cadence + tsc_category', async () => {
    const { rows } = await client.query<{
      control_id: string;
      control_class: string;
      eval_cadence: string;
      tsc_category: string;
    }>(
      `SELECT control_id, control_class, eval_cadence, tsc_category
         FROM compliance_controls
        WHERE control_id IN (
          'vendor-risk-review', 'cloud-access-review', 'cloud-security-audit',
          'policy-acknowledgment', 'policy-review'
        )`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.control_id, r]));
    expect(byId['vendor-risk-review']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'quarterly', tsc_category: 'CC9.1' }),
    );
    expect(byId['cloud-access-review']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'monthly', tsc_category: 'CC6.6' }),
    );
    expect(byId['cloud-security-audit']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'quarterly', tsc_category: 'CC7.2' }),
    );
    expect(byId['policy-acknowledgment']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'yearly', tsc_category: 'CC2.2' }),
    );
    expect(byId['policy-review']).toEqual(
      expect.objectContaining({ control_class: 'human', eval_cadence: 'yearly', tsc_category: 'CC5.3' }),
    );
  });

  it("eval_cadence CHECK accepts 'yearly' after the migration widens the constraint", async () => {
    // Prove via a direct SELECT that the two policy controls landed at 'yearly' — the
    // INSERT above would have failed with a 23514 if the CHECK hadn't been widened.
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM compliance_controls WHERE eval_cadence = 'yearly'`,
    );
    expect(parseInt(rows[0]!.n, 10)).toBeGreaterThanOrEqual(2);
  });
});

// ── AC 6: signal types module (extends HUB-1384 registry) ────────────────────

describe('signalTypes module (AC 6)', () => {
  it('exports the 3 GRC-Lite Wave 4b signal type constants', () => {
    expect(SIGNAL_VENDOR_RISK_ASSESSED).toBe('vendor_risk_assessed');
    expect(SIGNAL_CLOUD_SECURITY_ATTESTED).toBe('cloud_security_attested');
    expect(SIGNAL_POLICY_ACKNOWLEDGED).toBe('policy_acknowledged');
    expect(GRC_WAVE4B_SIGNAL_TYPES).toHaveLength(3);
  });
});

// ── AC 7: idempotency ────────────────────────────────────────────────────────

describe('migration 069 idempotency (AC 7)', () => {
  it('re-running the seed INSERT does not fail and does not duplicate rows', async () => {
    await client.query(
      `INSERT INTO compliance_controls (control_id, name, description, tsc_category, control_class, eval_cadence, active)
       VALUES
         ('vendor-risk-review', 'x', 'x', 'CC9.1', 'human', 'quarterly', true)
       ON CONFLICT (control_id) DO NOTHING`,
    );
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM compliance_controls WHERE control_id = 'vendor-risk-review'`,
    );
    expect(rows[0]!.n).toBe('1');
  });
});
