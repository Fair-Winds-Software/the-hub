// Authorized by HUB-49 — thin raw-SQL migration runner; admin pg.Client per ADR-001
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import logger from '../lib/logger';

const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export async function runMigrations(migrationsDir?: string): Promise<void> {
  const dir = migrationsDir ?? path.join(process.cwd(), 'db', 'migrations');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Bootstrap: ensure schema_migrations exists before we query it
    await client.query(BOOTSTRAP_SQL);

    // Collect already-applied filenames
    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    const applied = new Set(rows.map((r) => r.filename));

    // Read migration files in lexicographic order
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        logger.debug({ file }, 'migration already applied, skipping');
        continue;
      }

      const filePath = path.join(dir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      logger.info({ file }, 'applying migration');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        logger.info({ file }, 'migration applied successfully');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ file, err }, 'migration failed — rolled back');
        throw err;
      }
    }

    logger.info('all migrations complete');
  } finally {
    await client.end();
  }
}

// CLI entrypoint
if (require.main === module) {
  runMigrations().catch((err) => {
    logger.error({ err }, 'migration runner failed');
    process.exit(1);
  });
}
