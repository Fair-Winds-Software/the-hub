// Authorized by HUB-4.1 L2 — unit tests: loginOperator, refreshOperatorToken, logoutOperator

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockClientQuery = vi.hoisted(() => vi.fn());
const mockClientRelease = vi.hoisted(() => vi.fn());
const mockPoolConnect = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockClientRelease }),
);

vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: mockPoolConnect }),
}));

const mockBcryptHash = vi.hoisted(() => vi.fn());
const mockBcryptCompare = vi.hoisted(() => vi.fn());
vi.mock('bcryptjs', () => ({
  default: { hash: mockBcryptHash, compare: mockBcryptCompare },
}));

const mockJwtSign = vi.hoisted(() => vi.fn().mockReturnValue('signed-access-token'));
vi.mock('jsonwebtoken', () => ({
  default: { sign: mockJwtSign },
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// HUB-1704: operatorAuth now writes audit entries on login/logout/refresh, but unit
// behavior is unchanged. Mock writeAuditEntry to a no-op so pool.query mocks remain
// tight against the auth flow's own queries. Audit-write integration coverage lives
// in __tests__/authAuditTrail.integration.test.ts.
vi.mock('../auditLogService.js', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue(undefined),
}));

import { loginOperator, refreshOperatorToken, logoutOperator } from '../operatorAuth.js';

const OPERATOR_ROW = {
  id: 'op-uuid-1',
  password_hash: '$2b$10$placeholder',
  role: 'super_admin' as const,
  tenant_id: null,
  active: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPERATOR_JWT_SECRET = 'test-op-secret';
  process.env.OPERATOR_JWT_TTL_SECONDS = '900';
  mockBcryptHash.mockResolvedValue('hashed-value');
  mockBcryptCompare.mockResolvedValue(true);
  mockJwtSign.mockReturnValue('signed-access-token');
});

// ── loginOperator ─────────────────────────────────────────────────────────────

describe('loginOperator()', () => {
  it('returns accessToken and refreshToken on valid credentials', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [OPERATOR_ROW] })                   // SELECT operator
      .mockResolvedValueOnce({ rows: [{ id: 'refresh-row-1' }] });       // INSERT refresh token

    const result = await loginOperator('admin@example.com', 'correct-password');

    expect(mockBcryptCompare).toHaveBeenCalledWith('correct-password', OPERATOR_ROW.password_hash);
    expect(mockJwtSign).toHaveBeenCalledWith(
      expect.objectContaining({ operator_id: 'op-uuid-1', role: 'super_admin', tenant_id: null }),
      'test-op-secret',
      expect.any(Object),
    );
    expect(result.accessToken).toBe('signed-access-token');
    expect(result.refreshToken).toMatch(/^refresh-row-1\./);
    expect(result.expiresIn).toBe(900);
  });

  it('includes tenant_id in JWT payload for tenant_admin', async () => {
    const tenantAdminRow = { ...OPERATOR_ROW, role: 'tenant_admin' as const, tenant_id: 'tenant-uuid-1' };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [tenantAdminRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'refresh-row-2' }] });

    await loginOperator('tenant@example.com', 'password');

    expect(mockJwtSign).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-uuid-1', role: 'tenant_admin' }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('throws AppError(401) when operator email not found — timing-safe compare still runs', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    mockBcryptCompare.mockResolvedValueOnce(false);

    await expect(loginOperator('nobody@example.com', 'any')).rejects.toMatchObject({
      statusCode: 401,
    });
    // Timing-safe: bcrypt.compare is still called even with no row
    expect(mockBcryptCompare).toHaveBeenCalledOnce();
  });

  it('throws AppError(401) when password is wrong', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [OPERATOR_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(false);

    await expect(loginOperator('admin@example.com', 'wrong')).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  it('throws AppError(401) when operator is inactive', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...OPERATOR_ROW, active: false }] });
    mockBcryptCompare.mockResolvedValueOnce(true);

    await expect(loginOperator('admin@example.com', 'password')).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

// ── refreshOperatorToken ──────────────────────────────────────────────────────

describe('refreshOperatorToken()', () => {
  const REFRESH_TOKEN = 'token-uuid-1.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  it('rotates token and returns new pair on valid refresh token', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'token-uuid-1', operator_id: 'op-uuid-1', token_hash: 'stored-hash' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'op-uuid-1', role: 'super_admin', tenant_id: null }] });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockClientQuery
      .mockResolvedValueOnce(undefined)                             // BEGIN
      .mockResolvedValueOnce(undefined)                             // UPDATE revoke old
      .mockResolvedValueOnce({ rows: [{ id: 'new-token-uuid-1' }] }) // INSERT new
      .mockResolvedValueOnce(undefined);                            // COMMIT

    const result = await refreshOperatorToken(REFRESH_TOKEN);

    expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('revoked = true'),
      ['token-uuid-1'],
    );
    expect(result.accessToken).toBe('signed-access-token');
    expect(result.refreshToken).toMatch(/^new-token-uuid-1\./);
    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('throws AppError(401) for malformed refresh token (no dot)', async () => {
    await expect(refreshOperatorToken('no-dot-here')).rejects.toMatchObject({ statusCode: 401 });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('throws AppError(401) when token not found or expired', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(refreshOperatorToken(REFRESH_TOKEN)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws AppError(401) when bcrypt comparison fails (tampered raw token)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'token-uuid-1', operator_id: 'op-uuid-1', token_hash: 'stored-hash' }],
    });
    mockBcryptCompare.mockResolvedValueOnce(false);

    await expect(refreshOperatorToken(REFRESH_TOKEN)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws AppError(401) when operator account no longer active', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'token-uuid-1', operator_id: 'op-uuid-1', token_hash: 'hash' }] })
      .mockResolvedValueOnce({ rows: [] }); // operator not found/inactive
    mockBcryptCompare.mockResolvedValueOnce(true);

    await expect(refreshOperatorToken(REFRESH_TOKEN)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rolls back transaction on error and re-throws', async () => {
    const dbError = new Error('DB failure');
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'token-uuid-1', operator_id: 'op-uuid-1', token_hash: 'hash' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'op-uuid-1', role: 'super_admin', tenant_id: null }] });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockClientQuery
      .mockResolvedValueOnce(undefined)  // BEGIN
      .mockRejectedValueOnce(dbError);   // UPDATE fails

    await expect(refreshOperatorToken(REFRESH_TOKEN)).rejects.toThrow(dbError);
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalled();
  });
});

// ── logoutOperator ────────────────────────────────────────────────────────────

describe('logoutOperator()', () => {
  it('revokes the refresh token in DB', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await logoutOperator('some-uuid.rawHexValue');

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('revoked = true'),
      ['some-uuid'],
    );
  });

  it('returns void silently for malformed token (idempotent)', async () => {
    await expect(logoutOperator('no-dot-malformed')).resolves.toBeUndefined();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
