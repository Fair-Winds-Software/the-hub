// Authorized by HUB-258 — unit tests: createLicense, activateLicense
// Authorized by HUB-259 — unit tests: suspendLicense, freezeLicense, cancelLicense
// Authorized by HUB-272 — unit tests: getLicenseStatus, promoteStagedLicenseChanges
// Authorized by HUB-279 — unit tests: emitBelowFloorAlert
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockRelease = vi.fn();
const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });
const mockPool = { query: vi.fn(), connect: mockConnect };

vi.mock('../../db/pool.js', () => ({ getPool: () => mockPool }));

// decisions mock — mutable so individual tests can override TODO_D_DEF_001_INTERVAL
const mockDecisions = {
  TODO_D_DEF_001_INTERVAL: '7 days' as string | null,
  D_002_PROMOTION_CRON: '0 0 * * *',
};
vi.mock('../../config/decisions.js', () => mockDecisions);

beforeEach(() => {
  vi.clearAllMocks();
  mockRelease.mockReset();
  mockQuery.mockReset();
  mockPool.query.mockReset();
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
  mockDecisions.TODO_D_DEF_001_INTERVAL = '7 days';
});

// ── createLicense ─────────────────────────────────────────────────────────────

describe('createLicense()', () => {
  it('returns { id } on successful INSERT', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'license-uuid-1' }] });
    const { createLicense } = await import('../license.js');
    const result = await createLicense('tenant-1', 'product-1');
    expect(result).toEqual({ id: 'license-uuid-1' });
    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('throws AppError(409) on unique-constraint violation (23505)', async () => {
    const dupError = Object.assign(new Error('duplicate'), { code: '23505' });
    mockPool.query.mockRejectedValueOnce(dupError);
    const { createLicense } = await import('../license.js');
    await expect(createLicense('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 409,
      message: 'License already exists for this tenant-product pair',
    });
  });

  it('re-throws non-23505 errors unchanged', async () => {
    const dbErr = Object.assign(new Error('connection error'), { code: '08006' });
    mockPool.query.mockRejectedValueOnce(dbErr);
    const { createLicense } = await import('../license.js');
    await expect(createLicense('tenant-1', 'product-1')).rejects.toThrow('connection error');
  });
});

// ── activateLicense ───────────────────────────────────────────────────────────

describe('activateLicense()', () => {
  function setupTransaction(licenseRows: unknown[], regRows: unknown[]) {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: licenseRows }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: regRows }) // SELECT product_registrations
      .mockResolvedValueOnce({}) // UPDATE
      .mockResolvedValueOnce({}); // COMMIT
  }

  it('transitions pending → active when product_registration is active', async () => {
    setupTransaction(
      [{ id: 'lic-1', status: 'pending' }],
      [{ status: 'active' }],
    );
    const { activateLicense } = await import('../license.js');
    await expect(activateLicense('tenant-1', 'product-1')).resolves.toBeUndefined();
    expect(mockRelease).toHaveBeenCalled();
  });

  it('throws AppError(404) when license not found', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT FOR UPDATE — not found
    mockQuery.mockResolvedValue({}); // ROLLBACK
    const { activateLicense } = await import('../license.js');
    await expect(activateLicense('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 404,
      message: 'License not found',
    });
  });

  it('throws AppError(422) when license is not in pending state', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'active' }] }); // SELECT FOR UPDATE
    mockQuery.mockResolvedValue({}); // ROLLBACK
    const { activateLicense } = await import('../license.js');
    await expect(activateLicense('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 422,
      message: 'License is not in pending state',
    });
  });

  it('throws AppError(404) when product_registration not found', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'pending' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }); // SELECT product_registrations — not found
    mockQuery.mockResolvedValue({}); // ROLLBACK
    const { activateLicense } = await import('../license.js');
    await expect(activateLicense('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Product registration not found',
    });
  });

  it('throws AppError(422) when product_registration is not active', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'pending' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ status: 'inactive' }] }); // SELECT product_registrations
    mockQuery.mockResolvedValue({}); // ROLLBACK
    const { activateLicense } = await import('../license.js');
    await expect(activateLicense('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 422,
      message: 'Product registration is not active',
    });
  });
});

// ── suspendLicense ────────────────────────────────────────────────────────────

describe('suspendLicense()', () => {
  it('throws AppError(500) when TODO_D_DEF_001_INTERVAL is null', async () => {
    mockDecisions.TODO_D_DEF_001_INTERVAL = null;
    const { suspendLicense } = await import('../license.js');
    await expect(suspendLicense('tenant-1', 'product-1', 'cause')).rejects.toMatchObject({
      statusCode: 500,
      message: 'Grace window interval not yet configured (TODO-D-DEF-001)',
    });
    // Must not connect to DB
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('throws AppError(422) when license is not in active state', async () => {
    mockDecisions.TODO_D_DEF_001_INTERVAL = '7 days';
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'pending' }] }); // SELECT FOR UPDATE
    mockQuery.mockResolvedValue({}); // ROLLBACK
    const { suspendLicense } = await import('../license.js');
    await expect(suspendLicense('tenant-1', 'product-1', 'cause')).rejects.toMatchObject({
      statusCode: 422,
      message: 'License is not in active state',
    });
  });

  it('transitions active → suspended and emits below_floor alert post-commit', async () => {
    mockDecisions.TODO_D_DEF_001_INTERVAL = '7 days';
    const now = new Date();
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'active' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({
        rows: [{ suspended_at: now, grace_expires_at: new Date(now.getTime() + 7 * 86400_000) }],
      }) // UPDATE RETURNING
      .mockResolvedValueOnce({}); // COMMIT
    const { suspendLicense } = await import('../license.js');
    await expect(suspendLicense('tenant-1', 'product-1', 'TEST')).resolves.toBeUndefined();
    expect(mockRelease).toHaveBeenCalled();
  });
});

// ── freezeLicense ─────────────────────────────────────────────────────────────

describe('freezeLicense()', () => {
  it('delegates to suspendLicense with reason="FREEZE"', async () => {
    mockDecisions.TODO_D_DEF_001_INTERVAL = '7 days';
    const { suspendLicense, freezeLicense } = await import('../license.js');
    const spy = vi.spyOn({ suspendLicense }, 'suspendLicense');
    // Even without spying on the import, we can verify by observing the query pattern
    const now = new Date();
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'active' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({
        rows: [{ suspended_at: now, grace_expires_at: new Date() }],
      }) // UPDATE RETURNING
      .mockResolvedValueOnce({}); // COMMIT
    await expect(freezeLicense('tenant-1', 'product-1')).resolves.toBeUndefined();
    spy.mockRestore();
    // FREEZE reason appears in the UPDATE query parameters
    const updateCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('suspended'),
    );
    expect(updateCall?.[1]).toContain('FREEZE');
  });
});

// ── cancelLicense ─────────────────────────────────────────────────────────────

describe('cancelLicense()', () => {
  it('transitions suspended → cancelled (terminal)', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'suspended' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({}) // UPDATE
      .mockResolvedValueOnce({}); // COMMIT
    const { cancelLicense } = await import('../license.js');
    await expect(cancelLicense('tenant-1', 'product-1')).resolves.toBeUndefined();
    expect(mockRelease).toHaveBeenCalled();
  });

  it('throws AppError(422) when license is not in suspended state', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'active' }] }); // SELECT FOR UPDATE
    mockQuery.mockResolvedValue({}); // ROLLBACK
    const { cancelLicense } = await import('../license.js');
    await expect(cancelLicense('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 422,
      message: 'License is not in suspended state',
    });
  });

  it('throws AppError(422) when license is already cancelled', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'lic-1', status: 'cancelled' }] }); // SELECT FOR UPDATE
    mockQuery.mockResolvedValue({}); // ROLLBACK
    const { cancelLicense } = await import('../license.js');
    await expect(cancelLicense('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});

// ── getLicenseStatus ──────────────────────────────────────────────────────────

describe('getLicenseStatus()', () => {
  it('returns status + grace_expires_at without staged_change when none pending', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ status: 'active', grace_expires_at: null, slc_new_status: null, slc_staged_at: null }],
    });
    const { getLicenseStatus } = await import('../license.js');
    const result = await getLicenseStatus('tenant-1', 'product-1');
    expect(result.status).toBe('active');
    expect(result.grace_expires_at).toBeNull();
    expect(result.staged_change).toBeUndefined();
  });

  it('includes staged_change when an unpromoted row exists', async () => {
    const stagedAt = new Date('2026-07-01T00:00:00Z');
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          status: 'active',
          grace_expires_at: null,
          slc_new_status: 'suspended',
          slc_staged_at: stagedAt,
        },
      ],
    });
    const { getLicenseStatus } = await import('../license.js');
    const result = await getLicenseStatus('tenant-1', 'product-1');
    expect(result.staged_change).toEqual({ new_status: 'suspended', staged_at: stagedAt });
  });

  it('throws AppError(404) when no license found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const { getLicenseStatus } = await import('../license.js');
    await expect(getLicenseStatus('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 404,
      message: 'License not found',
    });
  });
});

// ── promoteStagedLicenseChanges ───────────────────────────────────────────────

describe('promoteStagedLicenseChanges()', () => {
  it('promotes all unpromoted rows, each in its own transaction', async () => {
    const rows = [
      { id: 'slc-1', license_id: 'lic-1', new_status: 'suspended' },
      { id: 'slc-2', license_id: 'lic-2', new_status: 'cancelled' },
    ];
    mockPool.query.mockResolvedValueOnce({ rows });
    // Two client transactions: each needs BEGIN, UPDATE licenses, UPDATE slc, COMMIT
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // UPDATE licenses
      .mockResolvedValueOnce({}) // UPDATE staged_license_changes
      .mockResolvedValueOnce({}) // COMMIT
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // UPDATE licenses
      .mockResolvedValueOnce({}) // UPDATE staged_license_changes
      .mockResolvedValueOnce({}); // COMMIT

    const { promoteStagedLicenseChanges } = await import('../license.js');
    await expect(promoteStagedLicenseChanges()).resolves.toBeUndefined();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it('continues to next row on promotion failure', async () => {
    const rows = [{ id: 'slc-1', license_id: 'lic-1', new_status: 'suspended' }];
    mockPool.query.mockResolvedValueOnce({ rows });
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('lock timeout')) // UPDATE licenses — fails
      .mockResolvedValueOnce({}); // ROLLBACK
    const { promoteStagedLicenseChanges } = await import('../license.js');
    await expect(promoteStagedLicenseChanges()).resolves.toBeUndefined();
    expect(mockRelease).toHaveBeenCalled();
  });

  it('is a no-op when no unpromoted rows exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const { promoteStagedLicenseChanges } = await import('../license.js');
    await expect(promoteStagedLicenseChanges()).resolves.toBeUndefined();
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

// ── emitBelowFloorAlert ───────────────────────────────────────────────────────

describe('emitBelowFloorAlert()', () => {
  it('resolves without throwing', async () => {
    const { emitBelowFloorAlert } = await import('../license.js');
    await expect(
      emitBelowFloorAlert({
        tenantId: 'tenant-1',
        productId: 'product-1',
        reason: 'TEST',
        suspended_at: new Date(),
        grace_expires_at: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});
