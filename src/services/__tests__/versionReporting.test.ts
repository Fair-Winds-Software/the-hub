// Authorized by HUB-335 — unit tests: checkVersionCompatibility()
// Authorized by HUB-336 — unit tests: recordSdkVersion(), pruneOldVersionReports()
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockPool = { query: mockQuery };
vi.mock('../../db/pool.js', () => ({ getPool: () => mockPool }));

const mockPublish = vi.fn().mockResolvedValue(1);
vi.mock('../../redis/client.js', () => ({ getRedisClient: () => ({ publish: mockPublish }) }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mutable decisions mock — override TODO_D_DEF_002_INTERVAL per test
const mockDecisions = { TODO_D_DEF_002_INTERVAL: null as string | null };
vi.mock('../../config/decisions.js', () => mockDecisions);

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockPublish.mockResolvedValue(1);
  mockDecisions.TODO_D_DEF_002_INTERVAL = null;
});

// ── checkVersionCompatibility ─────────────────────────────────────────────────

describe('checkVersionCompatibility()', () => {
  it('returns { status: "supported", deprecated_at, sunset_at } for a supported version', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'supported', deprecated_at: null, sunset_at: null }],
    });
    const { checkVersionCompatibility } = await import('../versionReporting.js');
    const result = await checkVersionCompatibility('product-1', '1.0.0');
    expect(result).toEqual({ status: 'supported', deprecated_at: null, sunset_at: null });
  });

  it('returns { status: "deprecated", deprecated_at, sunset_at } for a deprecated version', async () => {
    const deprecatedAt = new Date('2025-01-01');
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'deprecated', deprecated_at: deprecatedAt, sunset_at: null }],
    });
    const { checkVersionCompatibility } = await import('../versionReporting.js');
    const result = await checkVersionCompatibility('product-1', '0.9.0');
    expect(result).toEqual({ status: 'deprecated', deprecated_at: deprecatedAt, sunset_at: null });
  });

  it('throws AppError(403) for a sunset version', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'sunset', deprecated_at: new Date(), sunset_at: new Date() }],
    });
    const { checkVersionCompatibility } = await import('../versionReporting.js');
    await expect(checkVersionCompatibility('product-1', '0.1.0')).rejects.toMatchObject({
      statusCode: 403,
      message: 'SDK version sunset; upgrade required',
    });
  });

  it('throws AppError(404) when version does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { checkVersionCompatibility } = await import('../versionReporting.js');
    await expect(checkVersionCompatibility('product-1', '99.0.0')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Unknown SDK version',
    });
  });
});

// ── recordSdkVersion ──────────────────────────────────────────────────────────

describe('recordSdkVersion()', () => {
  it('upserts row and returns it after version gate passes', async () => {
    const reportedAt = new Date();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ status: 'supported', deprecated_at: null, sunset_at: null }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'svr-1', tenant_id: 'tenant-1', product_id: 'product-1', sdk_version: '1.0.0', reported_at: reportedAt, delta_data: null, created_at: reportedAt }],
      });
    const { recordSdkVersion } = await import('../versionReporting.js');
    const result = await recordSdkVersion('tenant-1', 'product-1', '1.0.0');
    expect(result.sdk_version).toBe('1.0.0');
    expect(result.tenant_id).toBe('tenant-1');
  });

  it('propagates AppError(403) from checkVersionCompatibility without writing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'sunset', deprecated_at: new Date(), sunset_at: new Date() }],
    });
    const { recordSdkVersion } = await import('../versionReporting.js');
    await expect(recordSdkVersion('tenant-1', 'product-1', '0.1.0')).rejects.toMatchObject({
      statusCode: 403,
    });
    // Only the version check query was called — no upsert
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('propagates AppError(404) from checkVersionCompatibility without writing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { recordSdkVersion } = await import('../versionReporting.js');
    await expect(recordSdkVersion('tenant-1', 'product-1', '99.0.0')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('publishes to hub:sdk:version-report:{productId} after upsert', async () => {
    const reportedAt = new Date();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ status: 'supported', deprecated_at: null, sunset_at: null }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'svr-1', tenant_id: 'tenant-1', product_id: 'product-1', sdk_version: '1.0.0', reported_at: reportedAt, delta_data: null, created_at: reportedAt }],
      });
    const { recordSdkVersion } = await import('../versionReporting.js');
    await recordSdkVersion('tenant-1', 'product-1', '1.0.0');
    expect(mockPublish).toHaveBeenCalledWith(
      'hub:sdk:version-report:product-1',
      expect.stringContaining('"sdkVersion":"1.0.0"'),
    );
  });

  it('resolves without throwing when Redis publish fails', async () => {
    const reportedAt = new Date();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ status: 'supported', deprecated_at: null, sunset_at: null }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'svr-1', tenant_id: 'tenant-1', product_id: 'product-1', sdk_version: '1.0.0', reported_at: reportedAt, delta_data: null, created_at: reportedAt }],
      });
    mockPublish.mockRejectedValueOnce(new Error('Redis down'));
    const { recordSdkVersion } = await import('../versionReporting.js');
    await expect(recordSdkVersion('tenant-1', 'product-1', '1.0.0')).resolves.toBeDefined();
  });
});

// ── pruneOldVersionReports ────────────────────────────────────────────────────

describe('pruneOldVersionReports()', () => {
  it('throws AppError(500) when TODO_D_DEF_002_INTERVAL is null', async () => {
    mockDecisions.TODO_D_DEF_002_INTERVAL = null;
    const { pruneOldVersionReports } = await import('../versionReporting.js');
    await expect(pruneOldVersionReports()).rejects.toMatchObject({
      statusCode: 500,
      message: 'SDK version retention interval not configured',
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('deletes rows older than the configured interval', async () => {
    mockDecisions.TODO_D_DEF_002_INTERVAL = '90 days';
    mockQuery.mockResolvedValueOnce({ rowCount: 5 });
    const { pruneOldVersionReports } = await import('../versionReporting.js');
    await expect(pruneOldVersionReports()).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM sdk_version_reports'),
      ['90 days'],
    );
  });
});
