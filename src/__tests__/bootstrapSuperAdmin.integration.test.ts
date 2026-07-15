// Verifies migration 084 seeded a working super_admin: fresh `docker-compose up + npm
// run migrate` produces a system where `sammy@fairwindssoftware.com / hub-dev-password`
// succeeds through the real loginOperator service (bcrypt.compare + JWT issuance).
//
// RUN_INTEGRATION=1 — needs a live PG with all migrations applied.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppError } from '../errors/AppError.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)('migration 084 — bootstrap super_admin', () => {
  beforeAll(() => {
    process.env['DATABASE_URL'] =
      process.env['DATABASE_URL'] ?? 'postgresql://hub:hub@localhost:5432/hub_dev';
    process.env['OPERATOR_JWT_SECRET'] =
      process.env['OPERATOR_JWT_SECRET'] ?? 'dev-jwt-secret-min-32-chars-long-for-hs256';
  });

  afterAll(async () => {
    const { closePool } = await import('../db/pool.js');
    await closePool();
  });

  it('sammy@fairwindssoftware.com + hub-dev-password → real login succeeds', async () => {
    const { loginOperator } = await import('../services/operatorAuth.js');
    const result = await loginOperator('sammy@fairwindssoftware.com', 'hub-dev-password');
    expect(result.accessToken).toBeTypeOf('string');
    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.refreshToken).toBeTypeOf('string');
    expect(result.expiresIn).toBeGreaterThan(0);
  });

  it('correct email + wrong password → AppError(401)', async () => {
    const { loginOperator } = await import('../services/operatorAuth.js');
    await expect(
      loginOperator('sammy@fairwindssoftware.com', 'not-the-dev-password'),
    ).rejects.toBeInstanceOf(AppError);
  });
});
