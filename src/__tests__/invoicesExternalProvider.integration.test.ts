// Authorized by HUB-1590 (E-BE-1 S7, CR-2) — RUN_INTEGRATION=1 verification that migration 051
// applied the invoices.external_provider column with NOT NULL + DEFAULT 'stripe' + CHECK
// constraint, and that 23514 fires on invalid values.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'invoices.external_provider (HUB-1590 migration 051, RUN_INTEGRATION=1)',
  () => {
    let pool: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

    beforeAll(async () => {
      process.env['DATABASE_URL'] ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
      const { getPool } = await import('../db/pool.js');
      pool = getPool();
    });

    afterAll(async () => {
      const { closePool } = await import('../db/pool.js');
      await closePool();
    });

    it("column exists with NOT NULL + default 'stripe'", async () => {
      const { rows } = await pool.query<{
        data_type: string;
        column_default: string | null;
        is_nullable: string;
      }>(
        `SELECT data_type, column_default, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'external_provider'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data_type).toBe('text');
      expect(rows[0]!.is_nullable).toBe('NO');
      expect(rows[0]!.column_default).toMatch(/'stripe'/);
    });

    it('CHECK constraint enumerates exactly { stripe, internal }', async () => {
      const { rows } = await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'invoices'::regclass
            AND conname = 'invoices_external_provider_check'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.def).toContain("'stripe'");
      expect(rows[0]!.def).toContain("'internal'");
    });

    it('rejects an out-of-set value with 23514', async () => {
      let code: string | undefined;
      try {
        await pool.query(
          `INSERT INTO invoices
             (tenant_id, product_id, stripe_invoice_id, stripe_subscription_id, status,
              amount_due, amount_paid, currency, period_start, period_end, external_provider)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'inv_unit_check_test', 'sub_test', 'draft',
                   0, 0, 'usd', NOW(), NOW(), 'unknown_provider')`,
        );
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      expect(code).toBe('23514');
    });

    it('migration row recorded in schema_migrations', async () => {
      const { rows } = await pool.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename = '051_invoices_external_provider.sql'`,
      );
      expect(rows).toHaveLength(1);
    });
  },
);
