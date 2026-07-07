// Authorized by HUB-1730 + HUB-1731 + HUB-1732 (E-V2-PP-2 S1/S2/S3, HUB-1726, HUB-1701) —
// Migration 072 schema tests. Verifies:
//   - custom_quotes header (status CHECK, decision_reason ≥20 chars when final)
//   - custom_quote_line_items (immutability after draft, sum-into-total trigger,
//     cross-product plan_id integrity)
//   - custom_quote_approvals (immutability, content_hash population, two-role
//     attestation invariant)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const CONNECTION_STRING = process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1701PP2-${Date.now()}`;

let client: Client;
let productId: string;
let otherProductId: string;
let planId: string;
let otherProductPlanId: string;
const creatorOperatorId = '00000000-0000-0000-0000-000000001111';
const approverOperatorId = '00000000-0000-0000-0000-000000002222';
let tenantId: string;

async function cleanup(c: Client): Promise<void> {
  // Approvals are immutable + REFERENCES custom_quotes with ON DELETE RESTRICT, so quotes
  // that have approvals must be left in place. Quotes without approvals cascade-delete
  // their line items (the child immutability trigger allows deletion when the parent is
  // already gone — SELECT returns NULL).
  const tid = tenantId ?? '00000000-0000-0000-0000-000000000000';
  await c.query(
    `DELETE FROM custom_quotes
      WHERE tenant_id = $1
        AND id NOT IN (SELECT quote_id FROM custom_quote_approvals)`,
    [tid],
  );
  // Plans, products, tenants can only be deleted if no dependent rows remain.
  // Immutable custom_quote_approvals hold quotes → products → tenants alive; that's
  // intentional (mirrors HUB-1454 vendor_risk_assessments pattern).
  await c.query(
    `DELETE FROM plans WHERE key LIKE $1 AND id NOT IN (SELECT plan_id FROM custom_quote_line_items WHERE plan_id IS NOT NULL)`,
    [`${RUN_TAG}-%`],
  );
  await c.query(
    `DELETE FROM products WHERE slug LIKE $1 AND id NOT IN (SELECT product_id FROM custom_quotes) AND id NOT IN (SELECT product_id FROM plans)`,
    [`${RUN_TAG.toLowerCase()}-%`],
  );
  await c.query(
    `DELETE FROM tenants WHERE name = $1 AND id NOT IN (SELECT tenant_id FROM custom_quotes) AND id NOT IN (SELECT tenant_id FROM products)`,
    [RUN_TAG],
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();

  // Seed a fresh tenant so we own the cleanup boundary.
  const tRes = await client.query<{ id: string }>(
    `INSERT INTO tenants (name, tenant_type) VALUES ($1, 'internal') RETURNING id`,
    [RUN_TAG],
  );
  tenantId = tRes.rows[0]!.id;

  const p1 = await client.query<{ id: string }>(
    `INSERT INTO products (slug, name, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${RUN_TAG.toLowerCase()}-prod`, `${RUN_TAG} product`, tenantId],
  );
  productId = p1.rows[0]!.id;

  const p2 = await client.query<{ id: string }>(
    `INSERT INTO products (slug, name, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${RUN_TAG.toLowerCase()}-other`, `${RUN_TAG} other`, tenantId],
  );
  otherProductId = p2.rows[0]!.id;

  const planRes = await client.query<{ id: string }>(
    `INSERT INTO plans (product_id, key, name, billing_type, stripe_product_id, stripe_price_id, active)
     VALUES ($1, $2, $3, 'flat_rate', $4, $5, true) RETURNING id`,
    [productId, `${RUN_TAG}-plan`, `${RUN_TAG} plan`, `prod_${RUN_TAG}P`, `price_${RUN_TAG}P`],
  );
  planId = planRes.rows[0]!.id;

  const otherPlanRes = await client.query<{ id: string }>(
    `INSERT INTO plans (product_id, key, name, billing_type, stripe_product_id, stripe_price_id, active)
     VALUES ($1, $2, $3, 'flat_rate', $4, $5, true) RETURNING id`,
    [otherProductId, `${RUN_TAG}-otherplan`, `${RUN_TAG} otherplan`, `prod_${RUN_TAG}OP`, `price_${RUN_TAG}OP`],
  );
  otherProductPlanId = otherPlanRes.rows[0]!.id;
});

afterAll(async () => {
  await cleanup(client);
  await client.end();
});

async function insertQuote(overrides: Partial<{ status: string; expires_at: string; decision_reason: string }> = {}): Promise<string> {
  const status = overrides.status ?? 'draft';
  const expiresAt = overrides.expires_at ?? new Date(Date.now() + 86400000 * 30).toISOString();
  const reason = overrides.decision_reason ?? null;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO custom_quotes (tenant_id, product_id, operator_id, status, expires_at, decision_reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, productId, creatorOperatorId, status, expiresAt, reason],
  );
  return rows[0]!.id;
}

// ── HUB-1730 (S1): custom_quotes header ──────────────────────────────────
describe('HUB-1730 (S1): custom_quotes table', () => {
  it('inserts a draft quote with defaults', async () => {
    const q = await insertQuote();
    const { rows } = await client.query<{ status: string; total_cents: number; currency: string }>(
      `SELECT status, total_cents, currency FROM custom_quotes WHERE id = $1`,
      [q],
    );
    expect(rows[0]).toEqual({ status: 'draft', total_cents: 0, currency: 'USD' });
  });

  it('rejects invalid status via CHECK', async () => {
    await expect(
      client.query(
        `INSERT INTO custom_quotes (tenant_id, product_id, operator_id, status, expires_at)
         VALUES ($1, $2, $3, 'quirk', NOW() + INTERVAL '1 day')`,
        [tenantId, productId, creatorOperatorId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects rejected status without ≥20-char decision_reason (S1 AC 5)', async () => {
    const q = await insertQuote({ status: 'pending' });
    await expect(
      client.query(
        `UPDATE custom_quotes SET status = 'rejected', decision_reason = $2 WHERE id = $1`,
        [q, 'short'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects direct draft→approved transition (S1 AC 3)', async () => {
    const q = await insertQuote();
    await expect(
      client.query(`UPDATE custom_quotes SET status = 'approved' WHERE id = $1`, [q]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows draft→pending→approved via pending', async () => {
    const q = await insertQuote();
    await client.query(`UPDATE custom_quotes SET status = 'pending' WHERE id = $1`, [q]);
    await client.query(`UPDATE custom_quotes SET status = 'approved' WHERE id = $1`, [q]);
    const { rows } = await client.query<{ status: string }>(`SELECT status FROM custom_quotes WHERE id = $1`, [q]);
    expect(rows[0]!.status).toBe('approved');
  });

  it('rejects transitions out of terminal statuses', async () => {
    const q = await insertQuote({ status: 'rejected', decision_reason: 'This quote is rejected because of budget constraints for this quarter.' });
    await expect(
      client.query(`UPDATE custom_quotes SET status = 'pending' WHERE id = $1`, [q]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ── HUB-1731 (S2): custom_quote_line_items ────────────────────────────────
describe('HUB-1731 (S2): custom_quote_line_items table', () => {
  it('sum-into-total trigger updates parent total_cents on INSERT', async () => {
    const q = await insertQuote();
    await client.query(
      `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
       VALUES ($1, 'Widget', 3, 5000, 0)`,
      [q],
    );
    const { rows } = await client.query<{ total_cents: number }>(
      `SELECT total_cents FROM custom_quotes WHERE id = $1`, [q],
    );
    expect(rows[0]!.total_cents).toBe(15000);
  });

  it('sum-into-total updates on multi-row INSERT + UPDATE + DELETE', async () => {
    const q = await insertQuote();
    await client.query(
      `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
       VALUES ($1, 'A', 2, 1000, 0), ($1, 'B', 1, 500, 1)`,
      [q],
    );
    let total = (await client.query<{ total_cents: number }>(
      `SELECT total_cents FROM custom_quotes WHERE id = $1`, [q],
    )).rows[0]!.total_cents;
    expect(total).toBe(2500);

    // UPDATE line item.
    await client.query(
      `UPDATE custom_quote_line_items SET quantity = 5 WHERE quote_id = $1 AND description = 'A'`,
      [q],
    );
    total = (await client.query<{ total_cents: number }>(
      `SELECT total_cents FROM custom_quotes WHERE id = $1`, [q],
    )).rows[0]!.total_cents;
    expect(total).toBe(5500);

    // DELETE line item.
    await client.query(`DELETE FROM custom_quote_line_items WHERE quote_id = $1 AND description = 'B'`, [q]);
    total = (await client.query<{ total_cents: number }>(
      `SELECT total_cents FROM custom_quotes WHERE id = $1`, [q],
    )).rows[0]!.total_cents;
    expect(total).toBe(5000);
  });

  it('rejects plan_id from a different product via cross-scope trigger (S2 AC 4)', async () => {
    const q = await insertQuote();
    await expect(
      client.query(
        `INSERT INTO custom_quote_line_items (quote_id, plan_id, description, quantity, unit_amount_cents, sort_order)
         VALUES ($1, $2, 'X', 1, 100, 0)`,
        [q, otherProductPlanId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts plan_id from the correct product', async () => {
    const q = await insertQuote();
    await client.query(
      `INSERT INTO custom_quote_line_items (quote_id, plan_id, description, quantity, unit_amount_cents, sort_order)
       VALUES ($1, $2, 'OK', 1, 100, 0)`,
      [q, planId],
    );
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM custom_quote_line_items WHERE quote_id = $1`, [q],
    );
    expect(parseInt(rows[0]!.n, 10)).toBe(1);
  });

  it('becomes immutable once parent status leaves draft (S2 AC 5)', async () => {
    const q = await insertQuote();
    await client.query(
      `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
       VALUES ($1, 'Locked', 1, 100, 0)`,
      [q],
    );
    // Transition to pending.
    await client.query(`UPDATE custom_quotes SET status = 'pending' WHERE id = $1`, [q]);
    // Now UPDATE should fail.
    await expect(
      client.query(
        `UPDATE custom_quote_line_items SET quantity = 2 WHERE quote_id = $1`,
        [q],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // And DELETE should fail.
    await expect(
      client.query(`DELETE FROM custom_quote_line_items WHERE quote_id = $1`, [q]),
    ).rejects.toMatchObject({ code: '23514' });
    // And INSERT of a new line item should fail.
    await expect(
      client.query(
        `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
         VALUES ($1, 'NEW', 1, 100, 1)`,
        [q],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects quantity < 1 via CHECK', async () => {
    const q = await insertQuote();
    await expect(
      client.query(
        `INSERT INTO custom_quote_line_items (quote_id, description, quantity, unit_amount_cents, sort_order)
         VALUES ($1, 'Z', 0, 100, 0)`,
        [q],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ── HUB-1732 (S3): custom_quote_approvals audit chain ─────────────────────
describe('HUB-1732 (S3): custom_quote_approvals table', () => {
  it('populates content_hash via BEFORE INSERT trigger + accepts two-role attestation', async () => {
    const q = await insertQuote({ status: 'pending' });
    const { rows } = await client.query<{ content_hash: string }>(
      `INSERT INTO custom_quote_approvals (quote_id, approver_operator_id, decision, reason)
       VALUES ($1, $2, 'approved', 'This quote covers Q4 partnership; approved after legal + finance review.')
       RETURNING content_hash`,
      [q, approverOperatorId],
    );
    expect(rows[0]!.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects two-role attestation violation: creator = approver (S3 AC 4)', async () => {
    const q = await insertQuote({ status: 'pending' });
    await expect(
      client.query(
        `INSERT INTO custom_quote_approvals (quote_id, approver_operator_id, decision, reason)
         VALUES ($1, $2, 'approved', 'This is a valid reason with more than twenty characters.')`,
        [q, creatorOperatorId], // SAME as quote's creator operator_id
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects reason < 20 chars via CHECK (S3 AC 5)', async () => {
    const q = await insertQuote({ status: 'pending' });
    await expect(
      client.query(
        `INSERT INTO custom_quote_approvals (quote_id, approver_operator_id, decision, reason)
         VALUES ($1, $2, 'rejected', 'too short')`,
        [q, approverOperatorId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rows are immutable — UPDATE and DELETE raise 23514 (S3 AC 3)', async () => {
    const q = await insertQuote({ status: 'pending' });
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO custom_quote_approvals (quote_id, approver_operator_id, decision, reason)
       VALUES ($1, $2, 'approved', 'Approved: this covers the full Q1 renewal with negotiated terms.')
       RETURNING id`,
      [q, approverOperatorId],
    );
    const rowId = rows[0]!.id;
    await expect(
      client.query(`UPDATE custom_quote_approvals SET reason = 'changed reason with enough characters' WHERE id = $1`, [rowId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(`DELETE FROM custom_quote_approvals WHERE id = $1`, [rowId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects decision other than approved|rejected via CHECK', async () => {
    const q = await insertQuote({ status: 'pending' });
    await expect(
      client.query(
        `INSERT INTO custom_quote_approvals (quote_id, approver_operator_id, decision, reason)
         VALUES ($1, $2, 'meh', 'Some reason with enough characters here for validation.')`,
        [q, approverOperatorId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
