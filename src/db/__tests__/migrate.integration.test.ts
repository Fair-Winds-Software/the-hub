// Authorized by HUB-49 — integration tests for migration runner against real PostgreSQL
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMigrations } from '../migrate.js';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://hub:hub@localhost:5432/hub_dev';

async function freshClient(): Promise<Client> {
  const client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  return client;
}

async function dropMigrationsTable(client: Client): Promise<void> {
  await client.query('DROP TABLE IF EXISTS schema_migrations');
}

let client: Client;

beforeAll(async () => {
  client = await freshClient();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await dropMigrationsTable(client);
});

describe('runMigrations', () => {
  it('creates schema_migrations table and applies SQL files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-migrate-'));
    fs.writeFileSync(
      path.join(dir, '001_test.sql'),
      'CREATE TABLE IF NOT EXISTS _hub_test_table (id SERIAL PRIMARY KEY);'
    );

    try {
      await runMigrations(dir);

      const { rows } = await client.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations ORDER BY filename'
      );
      expect(rows.map((r) => r.filename)).toContain('001_test.sql');

      const { rows: tables } = await client.query(
        "SELECT to_regclass('public._hub_test_table') AS t"
      );
      expect(tables[0].t).not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true });
      await client.query('DROP TABLE IF EXISTS _hub_test_table');
    }
  });

  it('is idempotent — re-running skips already-applied files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-migrate-'));
    fs.writeFileSync(
      path.join(dir, '001_idempotent.sql'),
      'CREATE TABLE IF NOT EXISTS _hub_idempotent (id SERIAL PRIMARY KEY);'
    );

    try {
      await runMigrations(dir);
      // Second run must not throw
      await expect(runMigrations(dir)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
      await client.query('DROP TABLE IF EXISTS _hub_idempotent');
    }
  });

  it('rolls back a failed migration and does not record it as applied', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-migrate-'));
    fs.writeFileSync(
      path.join(dir, '001_bad.sql'),
      'THIS IS NOT VALID SQL;;;'
    );

    try {
      await expect(runMigrations(dir)).rejects.toThrow();

      const { rows } = await client.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations WHERE filename = $1',
        ['001_bad.sql']
      );
      expect(rows).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('does not apply later files when an earlier file fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-migrate-'));
    fs.writeFileSync(path.join(dir, '001_bad.sql'), 'NOT SQL;');
    fs.writeFileSync(
      path.join(dir, '002_good.sql'),
      'CREATE TABLE IF NOT EXISTS _hub_should_not_exist (id SERIAL PRIMARY KEY);'
    );

    try {
      await expect(runMigrations(dir)).rejects.toThrow();

      const { rows: tables } = await client.query(
        "SELECT to_regclass('public._hub_should_not_exist') AS t"
      );
      expect(tables[0].t).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true });
      await client.query('DROP TABLE IF EXISTS _hub_should_not_exist');
    }
  });
});
