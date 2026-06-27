// Authorized by HUB-1525 — unit tests for validateEnv(): missing vars + LEASE_ENCRYPTION_KEY length check
// Authorized by HUB-4.1 L2 — Red Team M2/M5/L1: updated for 64-char hex validation + new required vars
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const REQUIRED_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'OPERATOR_JWT_SECRET',
  'LEASE_ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SIGNING_SECRET',
  'HOOK_ENCRYPTION_KEY',
  'JIRA_SERVICE_TOKEN',
  'JIRA_SERVICE_EMAIL',
] as const;

const VALID_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://hub:hub@localhost:5432/hub_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-jwt-secret-hub77',
  OPERATOR_JWT_SECRET: 'test-operator-jwt-secret-hub112',
  LEASE_ENCRYPTION_KEY: '00'.repeat(32), // 64 hex chars = 32-byte AES-256 key
  STRIPE_SECRET_KEY: 'sk_test_hub_unit_test_key',
  STRIPE_WEBHOOK_SIGNING_SECRET: 'whsec_test_hub_unit_test',
  HOOK_ENCRYPTION_KEY: '00'.repeat(32), // 64 hex chars = 32-byte AES-256 key
  // HUB-1592 (CR-1): Atlassian Cloud REST v3 Basic-auth pair per D-HUB-SCOPE-029.
  JIRA_SERVICE_TOKEN: 'test-jira-token-placeholder',
  JIRA_SERVICE_EMAIL: 'ci-test-jira@hub.invalid',
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

  it('does not throw when all required vars are present and LEASE_ENCRYPTION_KEY is a valid 64-char hex string', async () => {
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

  it('throws listing STRIPE_WEBHOOK_SIGNING_SECRET when it is missing', async () => {
    delete process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('STRIPE_WEBHOOK_SIGNING_SECRET');
  });

  it('throws listing HOOK_ENCRYPTION_KEY when it is missing', async () => {
    delete process.env.HOOK_ENCRYPTION_KEY;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('HOOK_ENCRYPTION_KEY');
  });

  it('throws listing JIRA_SERVICE_TOKEN when it is missing (HUB-1592 CR-1)', async () => {
    delete process.env.JIRA_SERVICE_TOKEN;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('JIRA_SERVICE_TOKEN');
  });

  it('throws listing JIRA_SERVICE_EMAIL when it is missing (HUB-1592 CR-1)', async () => {
    delete process.env.JIRA_SERVICE_EMAIL;
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('JIRA_SERVICE_EMAIL');
  });

  it('accepts the test placeholder values for the Jira auth pair (no format check per R1 FIX#1)', async () => {
    process.env.JIRA_SERVICE_TOKEN = 'test-jira-token-placeholder';
    process.env.JIRA_SERVICE_EMAIL = 'ci-test-jira@hub.invalid';
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).not.toThrow();
  });

  it('throws when LEASE_ENCRYPTION_KEY is too short to be 64 hex chars', async () => {
    process.env.LEASE_ENCRYPTION_KEY = 'short';
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('LEASE_ENCRYPTION_KEY must be exactly 64 hex characters');
  });

  it('throws when LEASE_ENCRYPTION_KEY is 63 hex chars (one short)', async () => {
    process.env.LEASE_ENCRYPTION_KEY = '0'.repeat(63);
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('LEASE_ENCRYPTION_KEY must be exactly 64 hex characters');
  });

  it('throws when LEASE_ENCRYPTION_KEY is 32 non-hex bytes (not valid hex)', async () => {
    process.env.LEASE_ENCRYPTION_KEY = 'x'.repeat(64); // 64 chars but non-hex
    const { validateEnv } = await import('../config/env.js');
    expect(() => validateEnv()).toThrow('LEASE_ENCRYPTION_KEY must be exactly 64 hex characters');
  });

  it('does not throw when LEASE_ENCRYPTION_KEY is exactly 64 valid hex chars', async () => {
    process.env.LEASE_ENCRYPTION_KEY = 'ff'.repeat(32); // valid 64-char hex
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
