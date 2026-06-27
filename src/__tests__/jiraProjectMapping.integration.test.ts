// Authorized by HUB-1592 (E-BE-1 S9, CR-1) — RUN_INTEGRATION=1 verification that migration 052
// seeded the jira_project_key_by_product row + the catalog entry exposes the right contract.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCatalogEntry, assertValueType } from '../types/settingsCatalog.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'jira_project_key_by_product seed (HUB-1592 migration 052, RUN_INTEGRATION=1)',
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

    it('settings row exists with the v0.1 initial 4-product mapping', async () => {
      const { rows } = await pool.query<{ value: Record<string, string> }>(
        `SELECT value FROM settings WHERE key = 'jira_project_key_by_product'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.value).toMatchObject({
        contenthelm: 'CH',
        hub: 'HUB',
        synapz: 'SYNC',
        launchkit: 'LK',
      });
    });

    it('settings catalog registers the key with type json + sensible default + description', () => {
      const entry = getCatalogEntry('jira_project_key_by_product');
      expect(entry).toBeDefined();
      expect(entry!.type).toBe('json');
      expect(entry!.introducedBy).toBe('HUB-1592');
      expect(entry!.default).toMatchObject({
        contenthelm: 'CH',
        hub: 'HUB',
        synapz: 'SYNC',
        launchkit: 'LK',
      });
    });

    it('assertValueType accepts an object value for the json-typed catalog entry', () => {
      const ok = assertValueType('jira_project_key_by_product', {
        contenthelm: 'CH',
        launchkit: 'LK',
      });
      expect(ok).toBe(true);
    });

    it('assertValueType rejects a non-object value for the json-typed catalog entry', () => {
      expect(assertValueType('jira_project_key_by_product', 'a string')).toBe(false);
      expect(assertValueType('jira_project_key_by_product', 42)).toBe(false);
      expect(assertValueType('jira_project_key_by_product', null)).toBe(false);
    });

    it('migration row recorded in schema_migrations', async () => {
      const { rows } = await pool.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename = '052_jira_project_mapping.sql'`,
      );
      expect(rows).toHaveLength(1);
    });
  },
);
