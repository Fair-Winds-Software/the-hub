// Authorized by HUB-50 — integration tests for core schema: tenants, products, product_registrations
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { MAVERICK_LAUNCH_TENANT_ID } from '../../constants.js';
import { getProductRegistrationByClientId } from '../queries/product_registrations.js';
import { getPool, closePool } from '../pool.js';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';

// Fixed UUIDs for test data — cleaned up in afterAll
const TEST_TENANT_ID = 'ffffffff-0000-0000-0000-000000000001';
const TEST_PRODUCT_ID = 'ffffffff-0000-0000-0000-000000000002';
const TEST_CLIENT_ID = 'ffffffff-0000-0000-0000-000000000003';

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();

  // Seed test fixtures used by multiple tests
  await client.query(
    `INSERT INTO tenants (id, name, tenant_type) VALUES ($1, 'Test Corp', 'external') ON CONFLICT DO NOTHING`,
    [TEST_TENANT_ID]
  );
  await client.query(
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ($1, $2, 'Test Product', 'test-product-hub50') ON CONFLICT DO NOTHING`,
    [TEST_PRODUCT_ID, TEST_TENANT_ID]
  );
  await client.query(
    `INSERT INTO product_registrations (id, product_id, client_id, client_secret_hash)
     VALUES (gen_random_uuid(), $1, $2, '$2y$12$placeholder_hash_for_hub50_test') ON CONFLICT DO NOTHING`,
    [TEST_PRODUCT_ID, TEST_CLIENT_ID]
  );
});

afterAll(async () => {
  await client.query(`DELETE FROM product_registrations WHERE client_id = $1`, [TEST_CLIENT_ID]);
  await client.query(`DELETE FROM products WHERE id = $1`, [TEST_PRODUCT_ID]);
  await client.query(`DELETE FROM tenants WHERE id = $1`, [TEST_TENANT_ID]);
  await client.end();
  await closePool();
});

describe('tenants table', () => {
  it('CHECK constraint rejects invalid tenant_type at DB level', async () => {
    const err = await client
      .query(`INSERT INTO tenants (id, name, tenant_type) VALUES (gen_random_uuid(), 'Bad', 'invalid')`)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23514'); // check_violation
  });

  it('Maverick Launch seed row exists with tenant_type=internal and status=active', async () => {
    const { rows } = await client.query(
      `SELECT tenant_type, status FROM tenants WHERE id = $1`,
      [MAVERICK_LAUNCH_TENANT_ID]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_type).toBe('internal');
    expect(rows[0].status).toBe('active');
  });

  it('duplicate seed INSERT is idempotent (ON CONFLICT DO NOTHING — no error)', async () => {
    await expect(
      client.query(
        `INSERT INTO tenants (id, name, tenant_type) VALUES ($1, 'Maverick Launch', 'internal') ON CONFLICT DO NOTHING`,
        [MAVERICK_LAUNCH_TENANT_ID]
      )
    ).resolves.not.toThrow();
  });

  it('tenants table has deleted_at column for soft-delete', async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'deleted_at'`
    );
    expect(rows).toHaveLength(1);
  });
});

describe('products table', () => {
  it('FK constraint rejects product with non-existent tenant_id', async () => {
    const err = await client
      .query(
        `INSERT INTO products (id, tenant_id, name, slug) VALUES (gen_random_uuid(), gen_random_uuid(), 'Orphan', 'orphan-slug')`
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23503'); // foreign_key_violation
  });
});

describe('indexes', () => {
  it('FK indexes exist on products.tenant_id and product_registrations.product_id', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('idx_products_tenant_id', 'idx_product_registrations_product_id')`
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('idx_products_tenant_id');
    expect(names).toContain('idx_product_registrations_product_id');
  });

  it('unique constraints exist on products.slug and product_registrations.client_id', async () => {
    const { rows } = await client.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public'
         AND constraint_type = 'UNIQUE'
         AND constraint_name IN ('products_slug_key', 'product_registrations_client_id_key')`
    );
    const names = rows.map((r) => r.constraint_name);
    expect(names).toContain('products_slug_key');
    expect(names).toContain('product_registrations_client_id_key');
  });
});

describe('product_registrations query layer — security', () => {
  it('getProductRegistrationByClientId does not include client_secret_hash in result', async () => {
    const pool = getPool();
    const row = await getProductRegistrationByClientId(pool, TEST_CLIENT_ID);

    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty('client_secret_hash');
    expect(row!.client_id).toBe(TEST_CLIENT_ID);
    expect(row!.product_id).toBe(TEST_PRODUCT_ID);
  });
});
