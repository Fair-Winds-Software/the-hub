// Authorized by HUB-49 — unit tests for pg pool singleton
import { describe, it, expect, afterEach } from 'vitest';
import { getPool, closePool } from '../pool';

afterEach(async () => {
  await closePool();
});

describe('getPool', () => {
  it('returns the same Pool instance on repeated calls', () => {
    process.env.DATABASE_URL = 'postgresql://hub:hub@localhost:5432/hub_dev';
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
  });

  it('throws when DATABASE_URL is not set', () => {
    delete process.env.DATABASE_URL;
    expect(() => getPool()).toThrow('DATABASE_URL environment variable is not set');
  });

  it('respects DB_POOL_SIZE and DB_IDLE_TIMEOUT_MS env vars', () => {
    process.env.DATABASE_URL = 'postgresql://hub:hub@localhost:5432/hub_dev';
    process.env.DB_POOL_SIZE = '5';
    process.env.DB_IDLE_TIMEOUT_MS = '10000';
    const pool = getPool();
    type PoolOptions = { max: number; idleTimeoutMillis: number };
    const opts = (pool as unknown as { options: PoolOptions }).options;
    expect(opts.max).toBe(5);
    expect(opts.idleTimeoutMillis).toBe(10000);
    delete process.env.DB_POOL_SIZE;
    delete process.env.DB_IDLE_TIMEOUT_MS;
  });
});
