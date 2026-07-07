// Authorized by HUB-1715 + HUB-1716 + HUB-1717 (E-V2-PP-1 S2/S3/S4, HUB-1713, HUB-1701) —
// migration 071 schema tests. Verifies the volume_ladder JSONB column, first_n_free
// + quantity_metered_dimension columns with CHECK constraints, and the plan_bundles
// table with its member_plan_ids FK-integrity trigger + all CHECKs (member count ≥2,
// discount value bounds, per-product uniqueness).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const CONNECTION_STRING = process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1701PP1-${Date.now()}`;

let client: Client;
let productId: string;
let planA: string;
let planB: string;

async function cleanupTestRows(c: Client): Promise<void> {
  await c.query(`DELETE FROM plan_bundles WHERE bundle_name LIKE $1`, [`${RUN_TAG}%`]);
  await c.query(`DELETE FROM plans WHERE key LIKE $1`, [`${RUN_TAG}-%`]);
  await c.query(`DELETE FROM products WHERE slug LIKE $1`, [`${RUN_TAG.toLowerCase()}-%`]);
}

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  await cleanupTestRows(client);

  // Seed a product + two plans as fixtures for the bundle tests.
  const productRes = await client.query<{ id: string }>(
    `INSERT INTO products (slug, name, tenant_id)
     SELECT $1, $2, id FROM tenants LIMIT 1
     RETURNING id`,
    [`${RUN_TAG.toLowerCase()}-prod`, `${RUN_TAG} product`],
  );
  productId = productRes.rows[0]!.id;

  const planARes = await client.query<{ id: string }>(
    `INSERT INTO plans (product_id, key, name, billing_type, stripe_product_id, stripe_price_id)
     VALUES ($1, $2, $3, 'flat_rate', $4, $5) RETURNING id`,
    [productId, `${RUN_TAG}-A`, `${RUN_TAG} A`, `prod_${RUN_TAG}A`, `price_${RUN_TAG}A`],
  );
  planA = planARes.rows[0]!.id;

  const planBRes = await client.query<{ id: string }>(
    `INSERT INTO plans (product_id, key, name, billing_type, stripe_product_id, stripe_price_id)
     VALUES ($1, $2, $3, 'flat_rate', $4, $5) RETURNING id`,
    [productId, `${RUN_TAG}-B`, `${RUN_TAG} B`, `prod_${RUN_TAG}B`, `price_${RUN_TAG}B`],
  );
  planB = planBRes.rows[0]!.id;
});

afterAll(async () => {
  await cleanupTestRows(client);
  await client.end();
});

// ── HUB-1715 (S2) plans.volume_ladder JSONB column ──────────────────────────
describe('HUB-1715 (S2): plans.volume_ladder JSONB', () => {
  it('is nullable JSONB column on plans', async () => {
    const res = await client.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name='plans' AND column_name='volume_ladder'`,
    );
    expect(res.rows[0]).toEqual({ data_type: 'jsonb', is_nullable: 'YES' });
  });

  it('accepts a valid volume_ladder JSONB payload on UPDATE', async () => {
    await client.query(
      `UPDATE plans SET volume_ladder = $2 WHERE id = $1`,
      [
        planA,
        JSON.stringify([
          { min_quantity: 1, max_quantity: 1, unit_amount_cents: 0, sort_order: 0 },
          { min_quantity: 2, max_quantity: 2, unit_amount_cents: 50000, sort_order: 1 },
          { min_quantity: 3, max_quantity: null, unit_amount_cents: 30000, sort_order: 2 },
        ]),
      ],
    );
    const res = await client.query<{ volume_ladder: unknown }>(
      `SELECT volume_ladder FROM plans WHERE id = $1`, [planA],
    );
    expect(Array.isArray(res.rows[0]!.volume_ladder)).toBe(true);
    expect((res.rows[0]!.volume_ladder as Array<{ unit_amount_cents: number }>).length).toBe(3);
  });
});

// ── HUB-1716 (S3) plans.first_n_free_quantity + quantity_metered_dimension ──
describe('HUB-1716 (S3): first_n_free_quantity + quantity_metered_dimension', () => {
  it('first_n_free_quantity defaults to 0 and is NOT NULL', async () => {
    const res = await client.query<{ first_n_free_quantity: number }>(
      `SELECT first_n_free_quantity FROM plans WHERE id = $1`, [planA],
    );
    expect(res.rows[0]!.first_n_free_quantity).toBe(0);
  });

  it('rejects negative first_n_free_quantity via CHECK (S3 AC 2)', async () => {
    await expect(
      client.query(`UPDATE plans SET first_n_free_quantity = -1 WHERE id = $1`, [planA]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts valid snake_case quantity_metered_dimension (S3 AC 2)', async () => {
    await client.query(
      `UPDATE plans SET quantity_metered_dimension = $2, first_n_free_quantity = $3 WHERE id = $1`,
      [planA, 'environment', 1],
    );
    const res = await client.query<{ quantity_metered_dimension: string; first_n_free_quantity: number }>(
      `SELECT quantity_metered_dimension, first_n_free_quantity FROM plans WHERE id = $1`, [planA],
    );
    expect(res.rows[0]).toEqual({ quantity_metered_dimension: 'environment', first_n_free_quantity: 1 });
  });

  it('rejects non-snake_case dimension (e.g. uppercase) via CHECK', async () => {
    await expect(
      client.query(`UPDATE plans SET quantity_metered_dimension = 'BadDim' WHERE id = $1`, [planA]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows quantity_metered_dimension to be NULL (default state)', async () => {
    await client.query(
      `UPDATE plans SET quantity_metered_dimension = NULL, first_n_free_quantity = 0 WHERE id = $1`,
      [planA],
    );
    const res = await client.query<{ quantity_metered_dimension: string | null }>(
      `SELECT quantity_metered_dimension FROM plans WHERE id = $1`, [planA],
    );
    expect(res.rows[0]!.quantity_metered_dimension).toBeNull();
  });
});

// ── HUB-1717 (S4) plan_bundles table ────────────────────────────────────────
describe('HUB-1717 (S4): plan_bundles table', () => {
  afterAll(async () => {
    await client.query(`DELETE FROM plan_bundles WHERE bundle_name LIKE $1`, [`${RUN_TAG}%`]);
  });

  it('inserts a bundle with 2 member plans + flat_amount_cents discount (S4 AC 1)', async () => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
       VALUES ($1, $2, $3, 'flat_amount_cents', 50000) RETURNING id`,
      [productId, `${RUN_TAG} FullStack`, [planA, planB]],
    );
    expect(res.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects single-member bundle via CHECK (S4 AC 2)', async () => {
    await expect(
      client.query(
        `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
         VALUES ($1, $2, $3, 'flat_amount_cents', 100) `,
        [productId, `${RUN_TAG} Solo`, [planA]],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects percent_bps > 10000 via CHECK (S4 AC 3)', async () => {
    await expect(
      client.query(
        `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
         VALUES ($1, $2, $3, 'percent_bps', 10001) `,
        [productId, `${RUN_TAG} OverBps`, [planA, planB]],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts percent_bps at exact upper bound 10000', async () => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
       VALUES ($1, $2, $3, 'percent_bps', 10000) RETURNING id`,
      [productId, `${RUN_TAG} BoundaryBps`, [planA, planB]],
    );
    expect(res.rows[0]!.id).toBeDefined();
  });

  it('rejects nonexistent member plan via FK trigger with code 23503 (S4 AC 4)', async () => {
    const fakePlanId = '00000000-0000-0000-0000-000000000abc';
    await expect(
      client.query(
        `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
         VALUES ($1, $2, $3, 'flat_amount_cents', 100) `,
        [productId, `${RUN_TAG} MissingMember`, [planA, fakePlanId]],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects member plan from a different product via FK trigger', async () => {
    // Create a second product with its own plan.
    const otherProdRes = await client.query<{ id: string }>(
      `INSERT INTO products (slug, name, tenant_id)
       SELECT $1, $2, id FROM tenants LIMIT 1
       RETURNING id`,
      [`${RUN_TAG.toLowerCase()}-otherprod`, `${RUN_TAG} otherprod`],
    );
    const otherProdId = otherProdRes.rows[0]!.id;
    const otherPlanRes = await client.query<{ id: string }>(
      `INSERT INTO plans (product_id, key, name, billing_type, stripe_product_id, stripe_price_id)
       VALUES ($1, $2, $3, 'flat_rate', $4, $5) RETURNING id`,
      [otherProdId, `${RUN_TAG}-C`, `${RUN_TAG} C`, `prod_${RUN_TAG}C`, `price_${RUN_TAG}C`],
    );
    const otherPlanId = otherPlanRes.rows[0]!.id;

    await expect(
      client.query(
        `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
         VALUES ($1, $2, $3, 'flat_amount_cents', 100) `,
        [productId, `${RUN_TAG} CrossProduct`, [planA, otherPlanId]],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // Cleanup cross-product fixtures.
    await client.query(`DELETE FROM plans WHERE id = $1`, [otherPlanId]);
    await client.query(`DELETE FROM products WHERE id = $1`, [otherProdId]);
  });

  it('rejects duplicate bundle_name within the same product (S4 AC 6 via UNIQUE)', async () => {
    await client.query(
      `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
       VALUES ($1, $2, $3, 'flat_amount_cents', 200) `,
      [productId, `${RUN_TAG} DupTest`, [planA, planB]],
    );
    await expect(
      client.query(
        `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
         VALUES ($1, $2, $3, 'flat_amount_cents', 300) `,
        [productId, `${RUN_TAG} DupTest`, [planA, planB]],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('has delta_data column populated by universal_delta_tracker on UPDATE', async () => {
    const insRes = await client.query<{ id: string }>(
      `INSERT INTO plan_bundles (product_id, bundle_name, member_plan_ids, discount_type, discount_value)
       VALUES ($1, $2, $3, 'flat_amount_cents', 100) RETURNING id`,
      [productId, `${RUN_TAG} DeltaTest`, [planA, planB]],
    );
    const rowId = insRes.rows[0]!.id;
    await client.query(
      `UPDATE plan_bundles SET discount_value = 200 WHERE id = $1`, [rowId],
    );
    const res = await client.query<{ delta_data: Record<string, unknown> | null }>(
      `SELECT delta_data FROM plan_bundles WHERE id = $1`, [rowId],
    );
    expect(res.rows[0]!.delta_data).not.toBeNull();
  });
});
