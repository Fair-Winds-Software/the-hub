// Authorized by HUB-1744 (E-V2-PP-3 S4, HUB-1727, HUB-1701) — Integration tests for
// computeTenantOverage against real DB rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { computeTenantOverage } from '../overageAggregationService.js';
import { AppError } from '../../errors/AppError.js';

const CONNECTION_STRING = process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1744-${Date.now()}`;

let client: Client;
let tenantId: string;
let productId: string;
let planId: string;

// Synapz 4-dimension shape: rules / business_users / evaluations / symbolic_ops.
// Growth tier has:
//   rules:          100 included, 10¢/rule overage
//   business_users:  50 included, 100¢/user overage
//   evaluations:   1000 included, 5¢/eval overage
//   symbolic_ops:   500 included, 20¢/op overage
const GROWTH_TIER = {
  upTo: 5000,
  unitAmount: 99900, // $999 flat
  overage_rates: [
    { dimension_key: 'rules',          included_quantity: 100,  rate_per_unit_cents: 10 },
    { dimension_key: 'business_users', included_quantity: 50,   rate_per_unit_cents: 100 },
    { dimension_key: 'evaluations',    included_quantity: 1000, rate_per_unit_cents: 5 },
    { dimension_key: 'symbolic_ops',   included_quantity: 500,  rate_per_unit_cents: 20 },
  ],
};

const STARTER_TIER = {
  upTo: 1000,
  unitAmount: 9900,
  overage_rates: [
    { dimension_key: 'rules', included_quantity: 25, rate_per_unit_cents: 25 },
  ], // Only rules; other dimensions fall through to plan-level or 0
};

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

  // Create a plan with the two-tier Synapz shape.
  const planRes = await client.query<{ id: string }>(
    `INSERT INTO plans (product_id, key, name, billing_type, tiers,
                        stripe_product_id, stripe_price_id)
     VALUES ($1, $2, $3, 'tiered', $4::jsonb, $5, $6) RETURNING id`,
    [
      productId,
      `${RUN_TAG}-plan`,
      `${RUN_TAG} plan`,
      JSON.stringify([STARTER_TIER, GROWTH_TIER]),
      `prod_${RUN_TAG}`,
      `price_${RUN_TAG}`,
    ],
  );
  planId = planRes.rows[0]!.id;

  // Declare the 4 dimensions.
  const dims = ['rules', 'business_users', 'evaluations', 'symbolic_ops'];
  for (let i = 0; i < dims.length; i++) {
    await client.query(
      `INSERT INTO plan_metered_dimensions (plan_id, dimension_key, dimension_label, sort_order)
       VALUES ($1, $2, $3, $4)`,
      [planId, dims[i], `Label ${dims[i]}`, i],
    );
  }
});

afterAll(async () => {
  await client.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM plan_metered_dimensions WHERE plan_id = $1`, [planId]);
  await client.query(`DELETE FROM plans WHERE id = $1`, [planId]);
  await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  await client.end();
});

async function seedUsage(dimension: string, unitCount: number, when: Date): Promise<void> {
  await client.query(
    `INSERT INTO usage_events (tenant_id, product_id, event_type, unit_count, occurred_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, productId, dimension, unitCount, when.toISOString(), `${RUN_TAG}-${dimension}-${when.getTime()}-${Math.random()}`],
  );
}

// ── HUB-1744 (E-V2-PP-3 S4): computeTenantOverage ──────────────────────────
describe('HUB-1744 (S4): computeTenantOverage — Synapz 4-dim × 2-tier shape', () => {
  it('returns one row per declared dimension (AC 1)', async () => {
    const rows = await computeTenantOverage(
      tenantId,
      planId,
      1, // Growth tier
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.dimension_key)).toEqual([
      'rules', 'business_users', 'evaluations', 'symbolic_ops',
    ]);
  });

  it('returns overage=0 for dimension with usage below included (AC 2)', async () => {
    // Seed 50 rules — under Growth's 100 included.
    await seedUsage('rules', 50, new Date('2026-06-15T00:00:00Z'));
    const rows = await computeTenantOverage(
      tenantId, planId, 1,
      new Date('2026-06-14T00:00:00Z'),
      new Date('2026-06-16T00:00:00Z'),
    );
    const rulesRow = rows.find((r) => r.dimension_key === 'rules')!;
    expect(rulesRow.usage_quantity).toBe(50);
    expect(rulesRow.overage_quantity).toBe(0);
    expect(rulesRow.total_cents).toBe(0);
  });

  it('correctly computes overage cost when usage exceeds included (AC 1)', async () => {
    // Seed 150 additional rules → total 200 in period, 100 over → 100 * 10¢ = $10 = 1000 cents.
    await seedUsage('rules', 150, new Date('2026-06-16T01:00:00Z'));
    const rows = await computeTenantOverage(
      tenantId, planId, 1,
      new Date('2026-06-14T00:00:00Z'),
      new Date('2026-06-17T00:00:00Z'),
    );
    const rulesRow = rows.find((r) => r.dimension_key === 'rules')!;
    expect(rulesRow.usage_quantity).toBe(200);
    expect(rulesRow.included_quantity).toBe(100);
    expect(rulesRow.overage_quantity).toBe(100);
    expect(rulesRow.rate_per_unit_cents).toBe(10);
    expect(rulesRow.total_cents).toBe(1000);
    expect(rulesRow.used_tier_rate).toBe(true);
  });

  it('falls back to plan-level rate when tier lacks a dimension (AC 3)', async () => {
    // Starter tier only declares rules — the other 3 dimensions have no tier rate.
    // Seed 800 business_users usage. Fallback map provides plan-level rate.
    await seedUsage('business_users', 800, new Date('2026-08-01T00:00:00Z'));
    const rows = await computeTenantOverage(
      tenantId, planId,
      0, // Starter tier — has no business_users overage_rate
      new Date('2026-07-31T00:00:00Z'),
      new Date('2026-08-02T00:00:00Z'),
      { business_users: { dimension_key: 'business_users', included_quantity: 100, rate_per_unit_cents: 200 } },
    );
    const buRow = rows.find((r) => r.dimension_key === 'business_users')!;
    expect(buRow.usage_quantity).toBe(800);
    expect(buRow.included_quantity).toBe(100);
    expect(buRow.overage_quantity).toBe(700);
    expect(buRow.rate_per_unit_cents).toBe(200);
    expect(buRow.total_cents).toBe(140000); // 700 * 200 = 140,000 cents
    expect(buRow.used_tier_rate).toBe(false);
  });

  it('returns 0-cost row when neither tier nor fallback provides a rate', async () => {
    // Starter tier, no business_users tier rate, no fallback map.
    const rows = await computeTenantOverage(
      tenantId, planId, 0,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z'),
    );
    const buRow = rows.find((r) => r.dimension_key === 'business_users')!;
    expect(buRow.rate_per_unit_cents).toBe(0);
    expect(buRow.total_cents).toBe(0);
  });

  it('is reproducible: byte-identical result across repeated calls (AC 4)', async () => {
    const args = [
      tenantId, planId, 1,
      new Date('2026-06-14T00:00:00Z'),
      new Date('2026-06-17T00:00:00Z'),
    ] as const;
    const a = await computeTenantOverage(...args);
    const b = await computeTenantOverage(...args);
    expect(a).toEqual(b);
  });

  it('throws 404 for non-existent plan', async () => {
    await expect(
      computeTenantOverage(
        tenantId, '00000000-0000-0000-0000-000000000abc', 0,
        new Date(), new Date(),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('throws 400 for out-of-range tier index', async () => {
    await expect(
      computeTenantOverage(
        tenantId, planId, 99,
        new Date(), new Date(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws 400 when periodTo < periodFrom', async () => {
    await expect(
      computeTenantOverage(
        tenantId, planId, 1,
        new Date('2026-07-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
