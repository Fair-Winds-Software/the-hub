// Authorized by HUB-1525 — unit tests for validateEnv(): missing vars + LEASE_ENCRYPTION_KEY length check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const REQUIRED_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'OPERATOR_JWT_SECRET',
  'LEASE_ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
] as const;

const VALID_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://hub:hub@localhost:5432/hub_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-jwt-secret-hub77',
  OPERATOR_JWT_SECRET: 'test-operator-jwt-secret-hub112',
  LEASE_ENCRYPTION_KEY: 'test-lease-encryption-key-32bytes!!',
  STRIPE_SECRET_KEY: 'sk_test_hub_unit_test_key',
};

describe('validateEnv()', () => {
  let saved: Partial<Record<string, string | undefined>>;

  beforeEach(() => {
    saved = {};
    for (const key of REQUIRED_VARS) {
      saved[key] = process.env[key];
      process.env[key] = VALID_ENV[key];
    }
  });

  afterEach(() => {
    for (const key of REQUIRED_VARS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('does not throw when all required vars are present and LEASE_ENCRYPTION_KEY is ≥32 bytes', async () => {
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).not.toThrow();
  });

  it('throws listing DATABASE_URL when it is missing', async () => {
    delete process.env.DATABASE_URL;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('DATABASE_URL');
  });

  it('throws listing REDIS_URL when it is missing', async () => {
    delete process.env.REDIS_URL;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('REDIS_URL');
  });

  it('throws listing JWT_SECRET when it is missing', async () => {
    delete process.env.JWT_SECRET;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('JWT_SECRET');
  });

  it('throws listing OPERATOR_JWT_SECRET when it is missing', async () => {
    delete process.env.OPERATOR_JWT_SECRET;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('OPERATOR_JWT_SECRET');
  });

  it('throws listing LEASE_ENCRYPTION_KEY when it is missing', async () => {
    delete process.env.LEASE_ENCRYPTION_KEY;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('LEASE_ENCRYPTION_KEY');
  });

  it('throws listing STRIPE_SECRET_KEY when it is missing', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('STRIPE_SECRET_KEY');
  });

  it('throws when LEASE_ENCRYPTION_KEY is shorter than 32 bytes', async () => {
    process.env.LEASE_ENCRYPTION_KEY = 'short';
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('LEASE_ENCRYPTION_KEY is too short');
  });

  it('throws when LEASE_ENCRYPTION_KEY is exactly 31 bytes', async () => {
    process.env.LEASE_ENCRYPTION_KEY = 'a'.repeat(31);
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('LEASE_ENCRYPTION_KEY is too short');
  });

  it('does not throw when LEASE_ENCRYPTION_KEY is exactly 32 bytes', async () => {
    process.env.LEASE_ENCRYPTION_KEY = 'a'.repeat(32);
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).not.toThrow();
  });

  it('lists all missing vars in a single error when multiple are absent', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow(/DATABASE_URL.*REDIS_URL|REDIS_URL.*DATABASE_URL/);
  });
});
