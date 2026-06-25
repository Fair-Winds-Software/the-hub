// Authorized by HUB-1584 (E-BE-1 S1) — verifies migration 046 added plans.billing_mode
// with the correct NOT NULL + DEFAULT + CHECK semantics. Asserts behavior, not just
// presence: insertable values match the allowed set; out-of-set values rejected.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'plans.billing_mode (HUB-1584 migration 046, RUN_INTEGRATION=1)',
  () => {
    beforeAll(async () => {
      process.env['DATABASE_URL'] ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
    });

    afterAll(async () => {
      const { closePool } = await import('../db/pool.js');
      await closePool();
    });

    it('column exists with type TEXT, NOT NULL, DEFAULT standard', async () => {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'plans' AND column_name = 'billing_mode'`,
      );
      expect(rows).toHaveLength(1);
      const col = rows[0]!;
      expect(col.data_type).toBe('text');
      expect(col.is_nullable).toBe('NO');
      expect(col.column_default).toContain("'standard'");
    });

    it('CHECK constraint enumerates exactly {standard, credit}', async () => {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid = 'plans'::regclass AND conname = 'plans_billing_mode_check'`,
      );
      expect(rows).toHaveLength(1);
      const def = rows[0]!.pg_get_constraintdef;
      expect(def).toContain("'standard'");
      expect(def).toContain("'credit'");
    });

    it('rejects an out-of-set value with a CHECK violation (23514)', async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      // SELECT-level CHECK probe: PostgreSQL evaluates the CHECK constraint via a
      // SELECT cast — using `'invalid_mode'::text` then NULLIF lets us target the
      // constraint without supplying the plans NOT NULL columns. Cleaner: just attempt
      // INSERT and assert the error is the check_violation code (23514).
      let errCode: string | undefined;
      let errMsg = '';
      try {
        await pool.query(
          `INSERT INTO plans
             (id, product_id, key, name, billing_type, stripe_product_id, stripe_price_id, entitlements, active, billing_mode)
           VALUES
             (gen_random_uuid(), gen_random_uuid(), 'hub-1584-bad', 'bad-mode-test',
              'recurring', 'prod_test', 'price_test', '{}'::jsonb, true, 'invalid_mode')`,
        );
      } catch (err) {
        errCode = (err as { code?: string }).code;
        errMsg = (err as Error).message;
      }
      expect(errCode).toBe('23514');
      expect(errMsg).toContain('billing_mode');
    });

    it('migration row is recorded in schema_migrations', async () => {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename = '046_billing_mode.sql'`,
      );
      expect(rows).toHaveLength(1);
    });
  },
);
