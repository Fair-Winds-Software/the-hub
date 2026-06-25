// Authorized by HUB-1586 (E-BE-1 S3, CR-4) — verifies the 3-step rename (048/049/050)
// landed the canonical CHECK + that the audit emission contract holds (R1 FIX#1).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const HUB_INTERNAL_TENANT_ID = '00000000-0000-0000-0000-0000000000a1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'operator_accounts role rename (HUB-1586 migrations 048/049/050, RUN_INTEGRATION=1)',
  () => {
    beforeAll(async () => {
      process.env['DATABASE_URL'] ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
    });

    afterAll(async () => {
      const { closePool } = await import('../db/pool.js');
      await closePool();
    });

    it('final CHECK accepts exactly {super_admin, product_admin}', async () => {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid = 'operator_accounts'::regclass
            AND conname = 'operator_accounts_role_check'`,
      );
      expect(rows).toHaveLength(1);
      const def = rows[0]!.pg_get_constraintdef;
      expect(def).toContain("'super_admin'");
      expect(def).toContain("'product_admin'");
      expect(def).not.toContain("'tenant_admin'");
    });

    it('no rows with role=tenant_admin remain after Step 2', async () => {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM operator_accounts WHERE role = 'tenant_admin'`,
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('INSERT with role=tenant_admin fails with check_violation (23514)', async () => {
      const { getPool } = await import('../db/pool.js');
      let errCode: string | undefined;
      try {
        await getPool().query(
          `INSERT INTO operator_accounts (id, email, password_hash, role, active)
           VALUES (gen_random_uuid(), 'hub-1586-rejected@example.test', 'hash', 'tenant_admin', true)`,
        );
      } catch (err) {
        errCode = (err as { code?: string }).code;
      }
      expect(errCode).toBe('23514');
    });

    it('audit row count for system:role-rename-migration matches the pre-rename count', async () => {
      const { getPool } = await import('../db/pool.js');
      // Step 2 emits one audit row per migrated operator. With an empty operator_accounts
      // table at pre-migration time, that count is 0. Whatever the count is, it must equal
      // the number of operators currently in product_admin who carry the migration's
      // audit fingerprint (matching email).
      const { rows: auditRows } = await getPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_log
          WHERE tenant_id = $1::uuid
            AND actor_id = 'system:role-rename-migration'
            AND new_values->>'event' = 'role.renamed'`,
        [HUB_INTERNAL_TENANT_ID],
      );
      // Every emitted audit row must correspond to an operator that currently has
      // product_admin (i.e., the migration actually flipped them, vs. operators created
      // post-migration directly as product_admin).
      const { rows: matchedOps } = await getPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_log a
          WHERE a.tenant_id = $1::uuid
            AND a.actor_id = 'system:role-rename-migration'
            AND EXISTS (
              SELECT 1 FROM operator_accounts o
               WHERE o.id = a.record_id AND o.role = 'product_admin'
            )`,
        [HUB_INTERNAL_TENANT_ID],
      );
      // The set of audit rows referencing a now-product_admin operator must equal the
      // total audit rows — no orphans (per R1 FIX#1's single-CTE guarantee).
      expect(matchedOps[0]?.count).toBe(auditRows[0]?.count);
    });

    it('all 3 migrations recorded in schema_migrations', async () => {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{ filename: string }>(
        `SELECT filename FROM schema_migrations
          WHERE filename IN ('048_role_rename_step1.sql', '049_role_rename_step2.sql', '050_role_rename_step3.sql')
          ORDER BY filename ASC`,
      );
      expect(rows.map((r) => r.filename)).toEqual([
        '048_role_rename_step1.sql',
        '049_role_rename_step2.sql',
        '050_role_rename_step3.sql',
      ]);
    });
  },
);
