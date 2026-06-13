// Authorized by HUB-49 — pg Pool singleton; DATABASE_URL never logged
import { Pool } from 'pg';
import 'dotenv/config';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  _pool = new Pool({
    connectionString,
    max: parseInt(process.env.DB_POOL_SIZE ?? '10', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? '30000', 10),
    connectionTimeoutMillis: 5000,
  });

  _pool.on('error', (err) => {
    // Log pool-level errors without exposing the connection string
    process.stderr.write(`pg pool error: ${err.message}\n`);
  });

  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
