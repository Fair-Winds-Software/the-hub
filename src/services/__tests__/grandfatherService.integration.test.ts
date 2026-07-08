// Authorized by HUB-1750/1751/1753/1754 (E-V2-PP-4 S1/S2/S4/S5, HUB-1728, HUB-1701) —
// Integration tests for grandfather + upgrade-suggestion services.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
  calculateRenewalPrice,
  runGrandfatherExpirationReminders,
  evaluateUpgrade2of3,
  upsertUpgradeSuggestion,
  dismissUpgradeSuggestion,
  getUpgradeSuggestion,
} from '../grandfatherService.js';
import { AppError } from '../../errors/AppError.js';

const CONNECTION_STRING = process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1701PP4-${Date.now()}`;
const OPERATOR_ID = '00000000-0000-0000-0000-000000009999';

let client: Client;
let tenantId: string;
let productId: string;

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  const tRes = await client.query<{ id: string }>(
    `INSERT INTO tenants (name, tenant_type) VALUES ($1, 'internal') RETURNING id`,
    [RUN_TAG],
  );
  tenantId = tRes.rows[0]!.id;
  const pRes = await client.query<{ id: string }>(
    `INSERT INTO products (slug, name, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${RUN_TAG.toLowerCase()}-prod`, `${RUN_TAG} product`, tenantId],
  );
  productId = pRes.rows[0]!.id;
});

afterAll(async () => {
  await client.query(`DELETE FROM upgrade_suggestions WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM pricing_grandfathers WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  await client.end();
});

// ── HUB-1750 (S1) schema constraint tests ──────────────────────────────────
describe('HUB-1750 (S1): pricing_grandfathers schema', () => {
  it('rejects delta_cents = 0 via CHECK', async () => {
    await expect(
      client.query(
        `INSERT INTO pricing_grandfathers
           (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at, terms, created_by_operator_id)
         VALUES ($1, $2, 'custom', 0, '2026-01-01', '2027-01-01', 'This has plenty of characters', $3)`,
        [tenantId, productId, OPERATOR_ID],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects expires_at <= effective_from via CHECK', async () => {
    await expect(
      client.query(
        `INSERT INTO pricing_grandfathers
           (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at, terms, created_by_operator_id)
         VALUES ($1, $2, 'custom', -100, '2026-06-01', '2026-06-01', 'Terms text with enough length here', $3)`,
        [tenantId, productId, OPERATOR_ID],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects terms < 20 chars via CHECK', async () => {
    await expect(
      client.query(
        `INSERT INTO pricing_grandfathers
           (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at, terms, created_by_operator_id)
         VALUES ($1, $2, 'custom', -100, '2026-01-01', '2027-01-01', 'short', $3)`,
        [tenantId, productId, OPERATOR_ID],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects invalid policy_type', async () => {
    await expect(
      client.query(
        `INSERT INTO pricing_grandfathers
           (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at, terms, created_by_operator_id)
         VALUES ($1, $2, 'invalid_type', -100, '2026-01-01', '2027-01-01', 'Terms text with enough characters', $3)`,
        [tenantId, productId, OPERATOR_ID],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('UNIQUE (tenant_id, product_id, effective_from)', async () => {
    await client.query(
      `INSERT INTO pricing_grandfathers
         (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at, terms, created_by_operator_id)
       VALUES ($1, $2, 'custom', -100, '2026-02-01', '2027-01-01', 'Terms text with enough characters', $3)`,
      [tenantId, productId, OPERATOR_ID],
    );
    await expect(
      client.query(
        `INSERT INTO pricing_grandfathers
           (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at, terms, created_by_operator_id)
         VALUES ($1, $2, 'year1_migration_lock', -200, '2026-02-01', '2027-06-01', 'Different terms with enough characters', $3)`,
        [tenantId, productId, OPERATOR_ID],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ── HUB-1753 (S4) calculateRenewalPrice ───────────────────────────────────
describe('HUB-1753 (S4): calculateRenewalPrice', () => {
  it('returns base price when no grandfather applies (AC 3)', async () => {
    const res = await calculateRenewalPrice(
      tenantId, productId, 100000, new Date('2025-12-15T00:00:00Z'),
    );
    expect(res.applied_grandfather_id).toBeNull();
    expect(res.effective_price_cents).toBe(100000);
    expect(res.grandfather_delta_cents).toBe(0);
  });

  it('applies active grandfather delta (AC 1)', async () => {
    // 2026-02-01 grandfather with -100 delta was inserted above.
    const res = await calculateRenewalPrice(
      tenantId, productId, 100000, new Date('2026-06-01T00:00:00Z'),
    );
    expect(res.applied_grandfather_id).not.toBeNull();
    expect(res.grandfather_delta_cents).toBe(-100);
    expect(res.effective_price_cents).toBe(99900);
  });

  it('picks most-negative delta when multiple grandfathers apply (AC 1)', async () => {
    await client.query(
      `INSERT INTO pricing_grandfathers
         (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at, terms, created_by_operator_id)
       VALUES ($1, $2, '12_month_lock', -500, '2026-03-01', '2027-01-01', 'Better discount policy — bigger delta', $3)`,
      [tenantId, productId, OPERATOR_ID],
    );
    const res = await calculateRenewalPrice(
      tenantId, productId, 100000, new Date('2026-06-01T00:00:00Z'),
    );
    // -500 wins over -100.
    expect(res.grandfather_delta_cents).toBe(-500);
    expect(res.effective_price_cents).toBe(99500);
  });

  it('clamps effective_price to 0 (AC 2)', async () => {
    const res = await calculateRenewalPrice(
      tenantId, productId, 100, new Date('2026-06-01T00:00:00Z'),
    );
    expect(res.effective_price_cents).toBeGreaterThanOrEqual(0);
  });

  it('rejects negative basePriceCents with 400', async () => {
    await expect(
      calculateRenewalPrice(tenantId, productId, -50, new Date()),
    ).rejects.toBeInstanceOf(AppError);
  });
});

// ── HUB-1754 (S5) runGrandfatherExpirationReminders ───────────────────────
describe('HUB-1754 (S5): runGrandfatherExpirationReminders', () => {
  it('marks reminder_sent_at for grandfathers 30 days out', async () => {
    // Insert a grandfather expiring exactly 30 days from now.
    const in30 = new Date();
    in30.setUTCDate(in30.getUTCDate() + 30);
    await client.query(
      `INSERT INTO pricing_grandfathers
         (tenant_id, product_id, policy_type, delta_cents, effective_from, expires_at, terms, created_by_operator_id)
       VALUES ($1, $2, 'custom', -100, CURRENT_DATE - INTERVAL '60 days', $3::date, 'Reminder test with enough chars', $4)`,
      [tenantId, productId, in30.toISOString().slice(0, 10), OPERATOR_ID],
    );
    const result = await runGrandfatherExpirationReminders();
    expect(result.notified_ids.length).toBeGreaterThan(0);
    // Second run should be a no-op for the same rows (reminder_sent_at now populated).
    const second = await runGrandfatherExpirationReminders();
    expect(second.notified_ids.length).toBe(0);
  });
});

// ── HUB-1751 (S2) evaluateUpgrade2of3 pure logic ──────────────────────────
describe('HUB-1751 (S2): evaluateUpgrade2of3', () => {
  it('fires when ≥2 of last 3 periods exceed next-tier delta', () => {
    expect(evaluateUpgrade2of3([1000, 500, 200], 400)).toEqual({ should_suggest: true, matching_periods: 2 });
  });
  it('does not fire when only 1 of 3 exceeds', () => {
    expect(evaluateUpgrade2of3([100, 500, 100], 400)).toEqual({ should_suggest: false, matching_periods: 1 });
  });
  it('does not fire with fewer than 3 periods', () => {
    expect(evaluateUpgrade2of3([1000, 1000], 100)).toEqual({ should_suggest: false, matching_periods: 0 });
  });
  it('any 2 of 3 (not necessarily consecutive)', () => {
    expect(evaluateUpgrade2of3([1000, 200, 1000], 400)).toEqual({ should_suggest: true, matching_periods: 2 });
  });
  it('strict greater-than: exact equality does not count', () => {
    expect(evaluateUpgrade2of3([400, 400, 400], 400)).toEqual({ should_suggest: false, matching_periods: 0 });
  });
});

// ── HUB-1752 (S3) upgrade suggestion upsert + dismiss + read ──────────────
describe('HUB-1752 (S3): upgrade suggestion lifecycle', () => {
  it('upsert creates a new suggestion when none exists', async () => {
    const row = await upsertUpgradeSuggestion(
      tenantId, productId, 1,
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
      75000,
    );
    expect(row).not.toBeNull();
    expect(row!.suggested_tier_index).toBe(1);
  });

  it('get returns the active suggestion', async () => {
    const active = await getUpgradeSuggestion(tenantId, productId);
    expect(active).not.toBeNull();
    expect(active!.projected_savings_cents).toBe(75000);
  });

  it('dismiss sets cooldown; get returns null; re-upsert during cooldown returns null', async () => {
    const dismissed = await dismissUpgradeSuggestion(tenantId, productId);
    expect(dismissed).not.toBeNull();
    const after = await getUpgradeSuggestion(tenantId, productId);
    expect(after).toBeNull();
    // Re-upsert during cooldown returns null (no state change).
    const skipped = await upsertUpgradeSuggestion(
      tenantId, productId, 2,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-08-01T00:00:00Z'),
      99000,
    );
    expect(skipped).toBeNull();
  });
});
