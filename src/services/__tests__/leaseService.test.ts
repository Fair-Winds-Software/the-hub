// Authorized by HUB-370 — unit tests: issueLease() atomic chain
// Authorized by HUB-371 — unit tests: verifyLease() stateless HMAC + revocation
// Authorized by HUB-372 — unit tests: extendLease() + revokeLease()
// Authorized by HUB-538 — unit tests: issueLease, verifyLease, revokeLease
// Authorized by HUB-539 — unit tests: extendLease 5-day validation
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockGetLicenseStatus = vi.hoisted(() => vi.fn());
vi.mock('../../services/license.js', () => ({ getLicenseStatus: mockGetLicenseStatus }));

const mockGetAllGateSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../../services/featureGate.js', () => ({ getAllGateSnapshot: mockGetAllGateSnapshot }));

const mockCheckVersionCompatibility = vi.hoisted(() => vi.fn());
const mockRecordSdkVersion = vi.hoisted(() => vi.fn());
vi.mock('../../services/versionReporting.js', () => ({
  checkVersionCompatibility: mockCheckVersionCompatibility,
  recordSdkVersion: mockRecordSdkVersion,
}));

const mockEncryptLeaseToken = vi.hoisted(() => vi.fn().mockReturnValue('encrypted-token'));
const mockSignLeasePayload = vi.hoisted(() => vi.fn().mockReturnValue('mock-sig'));
const mockVerifyLeaseSignature = vi.hoisted(() => vi.fn());
vi.mock('../../lib/leaseCrypto.js', () => ({
  encryptLeaseToken: mockEncryptLeaseToken,
  signLeasePayload: mockSignLeasePayload,
  verifyLeaseSignature: mockVerifyLeaseSignature,
}));

vi.mock('../../config/decisions.js', () => ({ TODO_D_LEASE_RENEWAL_DAYS: null }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockClient = { query: mockClientQuery, release: mockRelease };
const mockConnect = vi.fn().mockResolvedValue(mockClient);
const mockPoolQuery = vi.fn();

vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: mockConnect }),
}));

import { issueLease, verifyLease, revokeLease, extendLease } from '../leaseService.js';
import { AppError } from '../../errors/AppError.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(mockClient);
  mockClientQuery.mockResolvedValue({});
  mockRecordSdkVersion.mockResolvedValue({});
});

// ── issueLease ────────────────────────────────────────────────────────────────

describe('issueLease()', () => {
  const setup = () => {
    mockGetLicenseStatus.mockResolvedValue({ status: 'active', grace_expires_at: null });
    mockGetAllGateSnapshot.mockResolvedValue({ featureA: true });
    mockCheckVersionCompatibility.mockResolvedValue({ status: 'supported', deprecated_at: null, sunset_at: null });
  };

  it('returns { signedPayload, expiresAt, renewsAt } on success', async () => {
    setup();
    const result = await issueLease('tenant-1', 'product-1', '1.0.0', 'secret');
    expect(result).toMatchObject({
      signedPayload: expect.any(String),
      expiresAt: expect.any(Date),
      renewsAt: expect.any(Date),
    });
    expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('throws AppError(403) when license is suspended', async () => {
    mockGetLicenseStatus.mockResolvedValue({ status: 'suspended', grace_expires_at: null });
    await expect(issueLease('tenant-1', 'product-1', '1.0.0', 'secret')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('throws AppError(403) when license is cancelled', async () => {
    mockGetLicenseStatus.mockResolvedValue({ status: 'cancelled', grace_expires_at: null });
    await expect(issueLease('tenant-1', 'product-1', '1.0.0', 'secret')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('propagates AppError(403) from checkVersionCompatibility (sunset version)', async () => {
    mockGetLicenseStatus.mockResolvedValue({ status: 'active', grace_expires_at: null });
    mockGetAllGateSnapshot.mockResolvedValue({});
    mockCheckVersionCompatibility.mockRejectedValue(new AppError(403, 'SDK version sunset; upgrade required'));
    await expect(issueLease('tenant-1', 'product-1', '0.1.0', 'secret')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows on INSERT failure — no partial lease persisted', async () => {
    setup();
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('DB error')) // INSERT
      .mockResolvedValueOnce({}); // ROLLBACK
    await expect(issueLease('tenant-1', 'product-1', '1.0.0', 'secret')).rejects.toThrow('DB error');
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('calls recordSdkVersion post-commit (fire-and-forget)', async () => {
    setup();
    await issueLease('tenant-1', 'product-1', '1.0.0', 'secret');
    expect(mockRecordSdkVersion).toHaveBeenCalledWith('tenant-1', 'product-1', '1.0.0');
  });

  it('resolves even when recordSdkVersion fails post-commit', async () => {
    setup();
    mockRecordSdkVersion.mockRejectedValueOnce(new Error('Redis down'));
    await expect(issueLease('tenant-1', 'product-1', '1.0.0', 'secret')).resolves.toBeDefined();
  });
});

// ── verifyLease ───────────────────────────────────────────────────────────────

describe('verifyLease()', () => {
  const LEASE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
  const makePayload = (overrides = {}) =>
    JSON.stringify({
      leaseId: LEASE_ID,
      tenantId: 'tenant-1',
      productId: 'product-1',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-12-31T00:00:00.000Z',
      renewsAt: '2099-12-31T00:00:00.000Z',
      gateSnapshot: {},
      versionStatus: 'supported',
      sdkVersion: '1.0.0',
      sig: 'valid-sig',
      ...overrides,
    });

  it('returns { valid: true, payload } when HMAC is valid and lease is active', async () => {
    mockVerifyLeaseSignature.mockReturnValue(true);
    mockPoolQuery.mockResolvedValue({
      rows: [{ revoked_at: null, expires_at: new Date('2099-12-31') }],
    });
    const result = await verifyLease(makePayload(), 'secret');
    expect(result.valid).toBe(true);
    expect(result.payload).toBeDefined();
  });

  it('returns { valid: false, reason: invalid_signature } on HMAC failure — no DB query', async () => {
    mockVerifyLeaseSignature.mockReturnValue(false);
    const result = await verifyLease(makePayload(), 'wrong-secret');
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('returns { valid: false, reason: invalid_signature } on malformed JSON — no DB query', async () => {
    const result = await verifyLease('not-json', 'secret');
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('returns { valid: false, reason: revoked } when revoked_at is set', async () => {
    mockVerifyLeaseSignature.mockReturnValue(true);
    mockPoolQuery.mockResolvedValue({
      rows: [{ revoked_at: new Date('2026-06-01'), expires_at: new Date('2099-12-31') }],
    });
    const result = await verifyLease(makePayload(), 'secret');
    expect(result).toEqual({ valid: false, reason: 'revoked' });
  });

  it('returns { valid: false, reason: expired } when expires_at is in the past', async () => {
    mockVerifyLeaseSignature.mockReturnValue(true);
    mockPoolQuery.mockResolvedValue({
      rows: [{ revoked_at: null, expires_at: new Date('2020-01-01') }],
    });
    const result = await verifyLease(makePayload(), 'secret');
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('revoked takes priority over expired', async () => {
    mockVerifyLeaseSignature.mockReturnValue(true);
    mockPoolQuery.mockResolvedValue({
      rows: [{ revoked_at: new Date('2026-06-01'), expires_at: new Date('2020-01-01') }],
    });
    const result = await verifyLease(makePayload(), 'secret');
    expect(result.reason).toBe('revoked');
  });
});

// ── revokeLease ───────────────────────────────────────────────────────────────

describe('revokeLease()', () => {
  it('returns the updated lease row on success', async () => {
    const row = { id: 'lease-1', revoked_at: new Date(), revoke_reason: 'policy violation' };
    mockPoolQuery.mockResolvedValue({ rows: [row] });
    const result = await revokeLease('lease-1', 'policy violation');
    expect(result.id).toBe('lease-1');
    expect(result.revoke_reason).toBe('policy violation');
  });

  it('throws AppError(404) when lease is not found', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await expect(revokeLease('nonexistent', 'reason')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── extendLease ───────────────────────────────────────────────────────────────

describe('extendLease()', () => {
  const activeLease = {
    expires_at: new Date('2099-12-31'),
    revoked_at: null,
    renews_at: new Date('2099-12-31'),
  };
  const extendedRow = { id: 'lease-1', expires_at: new Date('2100-01-05'), renews_at: new Date('2100-01-05') };

  beforeEach(() => {
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [activeLease] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [extendedRow] }) // UPDATE
      .mockResolvedValueOnce({}); // COMMIT
  });

  it('returns { leaseId, expiresAt, renewsAt } on success', async () => {
    const result = await extendLease('lease-1', 5, 'op-1');
    expect(result.leaseId).toBe('lease-1');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('throws AppError(400) when daysToExtend is not a multiple of 5', async () => {
    vi.clearAllMocks();
    await expect(extendLease('lease-1', 3, 'op-1')).rejects.toMatchObject({ statusCode: 400 });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('throws AppError(400) when daysToExtend is 0', async () => {
    vi.clearAllMocks();
    await expect(extendLease('lease-1', 0, 'op-1')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws AppError(400) when daysToExtend is negative', async () => {
    vi.clearAllMocks();
    await expect(extendLease('lease-1', -5, 'op-1')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws AppError(404) when lease is not found', async () => {
    mockClientQuery.mockReset();
    mockConnect.mockResolvedValue(mockClient);
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE — not found
      .mockResolvedValueOnce({}); // ROLLBACK
    await expect(extendLease('nonexistent', 5, 'op-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws AppError(409) when lease is revoked', async () => {
    mockClientQuery.mockReset();
    mockConnect.mockResolvedValue(mockClient);
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...activeLease, revoked_at: new Date() }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({}); // ROLLBACK
    await expect(extendLease('lease-1', 5, 'op-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('throws AppError(409) when lease is expired', async () => {
    mockClientQuery.mockReset();
    mockConnect.mockResolvedValue(mockClient);
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...activeLease, expires_at: new Date('2020-01-01') }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({}); // ROLLBACK
    await expect(extendLease('lease-1', 5, 'op-1')).rejects.toMatchObject({ statusCode: 409 });
  });
});
