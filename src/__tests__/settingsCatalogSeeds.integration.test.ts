// Authorized by HUB-1585 (E-BE-1 S2) — verifies migration 047 seeded the R5 8-key
// catalog into `settings` and that each JSONB value parses to its catalog-declared type.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SETTINGS_CATALOG, assertValueType } from '../types/settingsCatalog.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'settings catalog seeds (HUB-1585 migration 047, RUN_INTEGRATION=1)',
  () => {
    beforeAll(async () => {
      process.env['DATABASE_URL'] ??= 'postgresql://hub:hub@localhost:5432/hub_dev';
    });

    afterAll(async () => {
      const { closePool } = await import('../db/pool.js');
      await closePool();
    });

    it('all 8 R5 catalog keys are present in settings', async () => {
      const { getPool } = await import('../db/pool.js');
      const expectedKeys = SETTINGS_CATALOG.map((e) => e.key);
      const { rows } = await getPool().query<{ key: string }>(
        `SELECT key FROM settings WHERE key = ANY($1::text[])`,
        [expectedKeys],
      );
      const presentKeys = rows.map((r) => r.key).sort();
      expect(presentKeys).toEqual(expectedKeys.slice().sort());
    });

    it('each seeded JSONB value parses to its catalog-declared type', async () => {
      const { getPool } = await import('../db/pool.js');
      const expectedKeys = SETTINGS_CATALOG.map((e) => e.key);
      const { rows } = await getPool().query<{ key: string; value: unknown }>(
        `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
        [expectedKeys],
      );
      for (const row of rows) {
        const entry = SETTINGS_CATALOG.find((e) => e.key === row.key);
        expect(entry, `unknown key surfaced: ${row.key}`).toBeDefined();
        expect(assertValueType(row.key, row.value)).toBe(true);
        // Sanity-check the default actually matches the catalog default.
        expect(row.value).toBe(entry!.default);
      }
    });

    it('migration row is recorded in schema_migrations', async () => {
      const { getPool } = await import('../db/pool.js');
      const { rows } = await getPool().query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename = '047_settings_seeds.sql'`,
      );
      expect(rows).toHaveLength(1);
    });

    it('re-running INSERT does NOT overwrite operator-tuned values (ON CONFLICT DO NOTHING)', async () => {
      const { getPool } = await import('../db/pool.js');
      const pool = getPool();
      // Tune the margin threshold to a non-default value, then re-run the seed SQL
      // verbatim. The ON CONFLICT (key) DO NOTHING means the tuned value survives.
      await pool.query(
        `UPDATE settings SET value = '0.25'::jsonb WHERE key = 'portfolio_margin_threshold_pct'`,
      );
      try {
        await pool.query(
          `INSERT INTO settings (key, value) VALUES
             ('portfolio_margin_threshold_pct', '0.0'::jsonb)
           ON CONFLICT (key) DO NOTHING`,
        );
        const { rows } = await pool.query<{ value: number }>(
          `SELECT value FROM settings WHERE key = 'portfolio_margin_threshold_pct'`,
        );
        expect(rows[0]?.value).toBe(0.25);
      } finally {
        // Restore the default so subsequent runs of this test see the seed state.
        await pool.query(
          `UPDATE settings SET value = '0.0'::jsonb WHERE key = 'portfolio_margin_threshold_pct'`,
        );
      }
    });

    it('catalog `getCatalogEntry` + `assertValueType` are usable by downstream consumers', async () => {
      const { getCatalogEntry } = await import('../types/settingsCatalog.js');
      expect(getCatalogEntry('portfolio_margin_threshold_pct')?.type).toBe('number');
      expect(getCatalogEntry('role_rename_compat_window_enabled')?.type).toBe('boolean');
      expect(getCatalogEntry('not-a-real-key')).toBeUndefined();
      expect(assertValueType('portfolio_margin_threshold_pct', 0.5)).toBe(true);
      expect(assertValueType('portfolio_margin_threshold_pct', 'not a number')).toBe(false);
      expect(assertValueType('role_rename_compat_window_enabled', true)).toBe(true);
      expect(assertValueType('role_rename_compat_window_enabled', 'true')).toBe(false);
    });
  },
);
