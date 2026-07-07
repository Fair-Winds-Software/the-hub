// Authorized by HUB-1741 (E-V2-PP-3 S1, HUB-1727, HUB-1701) — migration 073 tests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const CONNECTION_STRING = process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
const RUN_TAG = `HUB1701PP3-${Date.now()}`;

let client: Client;
let productId: string;
let planId: string;

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  const productRes = await client.query<{ id: string }>(
    `INSERT INTO products (slug, name, tenant_id)
     SELECT $1, $2, id FROM tenants LIMIT 1 RETURNING id`,
    [`${RUN_TAG.toLowerCase()}-prod`, `${RUN_TAG} product`],
  );
  productId = productRes.rows[0]!.id;
  const planRes = await client.query<{ id: string }>(
    `INSERT INTO plans (product_id, key, name, billing_type, stripe_product_id, stripe_price_id)
     VALUES ($1, $2, $3, 'tiered', $4, $5) RETURNING id`,
    [productId, `${RUN_TAG}-plan`, `${RUN_TAG} plan`, `prod_${RUN_TAG}`, `price_${RUN_TAG}`],
  );
  planId = planRes.rows[0]!.id;
});

afterAll(async () => {
  await client.query(`DELETE FROM plan_metered_dimensions WHERE plan_id = $1`, [planId]);
  await client.query(`DELETE FROM plans WHERE id = $1`, [planId]);
  await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await client.end();
});

describe('HUB-1741 (E-V2-PP-3 S1): plan_metered_dimensions', () => {
  it('inserts Synapz 4-dimension shape (S1 AC 3: no artificial cap)', async () => {
    const dims = ['rules', 'business_users', 'evaluations', 'symbolic_ops'];
    for (let i = 0; i < dims.length; i++) {
      await client.query(
        `INSERT INTO plan_metered_dimensions (plan_id, dimension_key, dimension_label, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [planId, dims[i], `Label for ${dims[i]}`, i],
      );
    }
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM plan_metered_dimensions WHERE plan_id = $1`, [planId],
    );
    expect(parseInt(rows[0]!.n, 10)).toBe(4);
  });

  it('UNIQUE (plan_id, dimension_key) rejects duplicate insert (S1 AC 2)', async () => {
    await expect(
      client.query(
        `INSERT INTO plan_metered_dimensions (plan_id, dimension_key, dimension_label, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [planId, 'rules', 'Duplicate rules', 99],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects invalid dimension_key (CamelCase) via CHECK (S1 AC 4)', async () => {
    await expect(
      client.query(
        `INSERT INTO plan_metered_dimensions (plan_id, dimension_key, dimension_label, sort_order)
         VALUES ($1, 'RulesBad', 'X', 5)`,
        [planId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects too-short dimension_key (< 3 chars)', async () => {
    await expect(
      client.query(
        `INSERT INTO plan_metered_dimensions (plan_id, dimension_key, dimension_label, sort_order)
         VALUES ($1, 'ab', 'X', 6)`,
        [planId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ordered read by sort_order (S1 AC 5)', async () => {
    const { rows } = await client.query<{ dimension_key: string; sort_order: number }>(
      `SELECT dimension_key, sort_order FROM plan_metered_dimensions
        WHERE plan_id = $1 ORDER BY sort_order ASC, dimension_key ASC`,
      [planId],
    );
    expect(rows[0]!.sort_order).toBeLessThanOrEqual(rows[1]!.sort_order);
  });
});
