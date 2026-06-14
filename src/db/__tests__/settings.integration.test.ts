// Authorized by HUB-126 — integration tests for settings table, triggers, and delta tracking
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { closePool } from '../pool.js';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  // Ensure clean state for test keys
  await client.query(`DELETE FROM settings WHERE key LIKE 'hub126-test-%'`);
});

afterAll(async () => {
  await client.query(`DELETE FROM settings WHERE key LIKE 'hub126-test-%'`);
  await client.end();
  await closePool();
});

// ── Schema structure ──────────────────────────────────────────────────────────

describe('settings table — schema', () => {
  it('settings table exists with the correct columns', async () => {
    const { rows } = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'settings'
       ORDER BY ordinal_position`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('key');
    expect(cols).toContain('value');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
    expect(cols).toContain('delta_data');
  });

  it('delta_data column exists and accepts JSONB', async () => {
    const { rows } = await client.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'delta_data'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('jsonb');
  });

  it('key uniqueness constraint rejects duplicate keys', async () => {
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('hub126-test-unique', '"a"')`,
    );
    const err = await client
      .query(`INSERT INTO settings (key, value) VALUES ('hub126-test-unique', '"b"')`)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { code: string }).code).toBe('23505'); // unique_violation
    // Clean up
    await client.query(`DELETE FROM settings WHERE key = 'hub126-test-unique'`);
  });
});

// ── Delta tracking ────────────────────────────────────────────────────────────

describe('settings table — delta tracking', () => {
  it('UPDATE populates delta_data with before/after/changed_at snapshot', async () => {
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('hub126-test-update', '"original"')`,
    );

    await client.query(
      `UPDATE settings SET value = '"updated"' WHERE key = 'hub126-test-update'`,
    );

    const { rows } = await client.query<{ delta_data: Record<string, unknown> }>(
      `SELECT delta_data FROM settings WHERE key = 'hub126-test-update'`,
    );
    expect(rows).toHaveLength(1);
    const delta = rows[0].delta_data;
    expect(delta).toHaveProperty('before');
    expect(delta).toHaveProperty('after');
    expect(delta).toHaveProperty('changed_at');
    expect((delta.before as Record<string, unknown>).value).toBe('original');
    expect((delta.after as Record<string, unknown>).value).toBe('updated');

    await client.query(`DELETE FROM settings WHERE key = 'hub126-test-update'`);
  });

  it('UPDATE auto-stamps updated_at via settings_updated_at trigger', async () => {
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('hub126-test-timestamp', '"v1"')`,
    );
    const { rows: before } = await client.query<{ updated_at: Date }>(
      `SELECT updated_at FROM settings WHERE key = 'hub126-test-timestamp'`,
    );

    // Small delay to ensure updated_at differs
    await new Promise((r) => setTimeout(r, 5));

    await client.query(
      `UPDATE settings SET value = '"v2"' WHERE key = 'hub126-test-timestamp'`,
    );
    const { rows: after } = await client.query<{ updated_at: Date }>(
      `SELECT updated_at FROM settings WHERE key = 'hub126-test-timestamp'`,
    );

    expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime());

    await client.query(`DELETE FROM settings WHERE key = 'hub126-test-timestamp'`);
  });

  it('DELETE inserts a row into delta_log with table_name = "settings"', async () => {
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO settings (key, value) VALUES ('hub126-test-delete', '"to_delete"') RETURNING id`,
    );
    const settingsId = inserted[0].id;

    await client.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);

    const { rows } = await client.query<{ table_name: string; row_id: string }>(
      `SELECT table_name, row_id FROM delta_log WHERE row_id = $1`,
      [settingsId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('settings');
    expect(rows[0].row_id).toBe(settingsId);

    // Clean up delta_log entry
    await client.query(`DELETE FROM delta_log WHERE row_id = $1`, [settingsId]);
  });
});
