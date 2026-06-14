// Authorized by HUB-300 — unit tests: evaluateGate
// Authorized by HUB-301 — unit tests: setKillSwitch, setTenantFeatureOverride
// Authorized by HUB-314 — unit tests: getAllGateSnapshot
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockRelease = vi.fn();
const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });
const mockPool = { query: vi.fn(), connect: mockConnect };

vi.mock('../../db/pool.js', () => ({ getPool: () => mockPool }));

const mockPublish = vi.fn().mockResolvedValue(1);
vi.mock('../../redis/client.js', () => ({ getRedisClient: () => ({ publish: mockPublish }) }));

const mockGetLicenseStatus = vi.fn();
vi.mock('../license.js', () => ({ getLicenseStatus: mockGetLicenseStatus }));

beforeEach(() => {
  vi.clearAllMocks();
  mockRelease.mockReset();
  mockQuery.mockReset();
  mockPool.query.mockReset();
  mockPublish.mockResolvedValue(1);
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
});

// ── evaluateGate ──────────────────────────────────────────────────────────────

describe('evaluateGate()', () => {
  it('returns kill_switch source without calling getLicenseStatus', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'gate-1', default_enabled: true, kill_switch_active: true }],
    });
    const { evaluateGate } = await import('../featureGate.js');
    const result = await evaluateGate('tenant-1', 'product-1', 'FEATURE_A');
    expect(result).toEqual({ enabled: false, source: 'kill_switch' });
    expect(mockGetLicenseStatus).not.toHaveBeenCalled();
  });

  it('returns license_suspended when license is suspended', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'gate-1', default_enabled: true, kill_switch_active: false }],
    });
    mockGetLicenseStatus.mockResolvedValueOnce({ status: 'suspended', grace_expires_at: new Date() });
    const { evaluateGate } = await import('../featureGate.js');
    const result = await evaluateGate('tenant-1', 'product-1', 'FEATURE_A');
    expect(result).toEqual({ enabled: false, source: 'license_suspended' });
    // override query must NOT be called when license is suspended
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('returns license_suspended when license is cancelled', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'gate-1', default_enabled: true, kill_switch_active: false }],
    });
    mockGetLicenseStatus.mockResolvedValueOnce({ status: 'cancelled', grace_expires_at: null });
    const { evaluateGate } = await import('../featureGate.js');
    const result = await evaluateGate('tenant-1', 'product-1', 'FEATURE_A');
    expect(result).toEqual({ enabled: false, source: 'license_suspended' });
  });

  it('returns tenant_override when override exists', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'gate-1', default_enabled: true, kill_switch_active: false }] })
      .mockResolvedValueOnce({ rows: [{ enabled: false }] });
    mockGetLicenseStatus.mockResolvedValueOnce({ status: 'active', grace_expires_at: null });
    const { evaluateGate } = await import('../featureGate.js');
    const result = await evaluateGate('tenant-1', 'product-1', 'FEATURE_A');
    expect(result).toEqual({ enabled: false, source: 'tenant_override' });
  });

  it('returns default when no override and license is active', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'gate-1', default_enabled: false, kill_switch_active: false }] })
      .mockResolvedValueOnce({ rows: [] });
    mockGetLicenseStatus.mockResolvedValueOnce({ status: 'active', grace_expires_at: null });
    const { evaluateGate } = await import('../featureGate.js');
    const result = await evaluateGate('tenant-1', 'product-1', 'FEATURE_A');
    expect(result).toEqual({ enabled: false, source: 'default' });
  });

  it('throws AppError(404) when gate not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const { evaluateGate } = await import('../featureGate.js');
    await expect(evaluateGate('tenant-1', 'product-1', 'UNKNOWN')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Feature gate not found',
    });
  });
});

// ── setKillSwitch ─────────────────────────────────────────────────────────────

describe('setKillSwitch()', () => {
  it('updates kill switch fields and broadcasts to Redis', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'gate-1' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({}) // UPDATE
      .mockResolvedValueOnce({}); // COMMIT
    const { setKillSwitch } = await import('../featureGate.js');
    await expect(
      setKillSwitch('product-1', 'FEATURE_A', true, 'maintenance', 'op-1'),
    ).resolves.toBeUndefined();
    expect(mockRelease).toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'hub:settings:gates:product-1',
      JSON.stringify({ type: 'gate_change', productId: 'product-1', gateKey: 'FEATURE_A' }),
    );
  });

  it('throws AppError(404) when gate not found', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT FOR UPDATE — not found
    mockQuery.mockResolvedValue({}); // ROLLBACK
    const { setKillSwitch } = await import('../featureGate.js');
    await expect(setKillSwitch('product-1', 'UNKNOWN', true, null, 'op-1')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Feature gate not found',
    });
    expect(mockRelease).toHaveBeenCalled();
  });

  it('resolves without throwing when Redis publish fails', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'gate-1' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({}) // UPDATE
      .mockResolvedValueOnce({}); // COMMIT
    mockPublish.mockRejectedValueOnce(new Error('Redis down'));
    const { setKillSwitch } = await import('../featureGate.js');
    await expect(
      setKillSwitch('product-1', 'FEATURE_A', false, null, 'op-1'),
    ).resolves.toBeUndefined();
  });
});

// ── setTenantFeatureOverride ──────────────────────────────────────────────────

describe('setTenantFeatureOverride()', () => {
  it('upserts override and broadcasts to Redis', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'gate-1' }] }) // gate existence check
      .mockResolvedValueOnce({}); // INSERT ... ON CONFLICT DO UPDATE
    const { setTenantFeatureOverride } = await import('../featureGate.js');
    await expect(
      setTenantFeatureOverride('tenant-1', 'product-1', 'FEATURE_A', true, 'beta access', 'op-1'),
    ).resolves.toBeUndefined();
    expect(mockPublish).toHaveBeenCalledWith(
      'hub:settings:gates:product-1',
      JSON.stringify({ type: 'gate_change', productId: 'product-1', gateKey: 'FEATURE_A' }),
    );
  });

  it('throws AppError(404) when gate not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const { setTenantFeatureOverride } = await import('../featureGate.js');
    await expect(
      setTenantFeatureOverride('tenant-1', 'product-1', 'UNKNOWN', true, null, 'op-1'),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Feature gate not found',
    });
  });

  it('resolves without throwing when Redis publish fails', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'gate-1' }] })
      .mockResolvedValueOnce({});
    mockPublish.mockRejectedValueOnce(new Error('Redis down'));
    const { setTenantFeatureOverride } = await import('../featureGate.js');
    await expect(
      setTenantFeatureOverride('tenant-1', 'product-1', 'FEATURE_A', false, null, 'op-1'),
    ).resolves.toBeUndefined();
  });
});

// ── getAllGateSnapshot ────────────────────────────────────────────────────────

describe('getAllGateSnapshot()', () => {
  it('returns snapshot with overrides applied correctly', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { gate_key: 'FEATURE_A', default_enabled: false, kill_switch_active: false },
          { gate_key: 'FEATURE_B', default_enabled: true, kill_switch_active: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ gate_key: 'FEATURE_A', enabled: true }] });
    mockGetLicenseStatus.mockResolvedValueOnce({ status: 'active', grace_expires_at: null });
    const { getAllGateSnapshot } = await import('../featureGate.js');
    const result = await getAllGateSnapshot('tenant-1', 'product-1');
    expect(result).toEqual({ FEATURE_A: true, FEATURE_B: true });
  });

  it('sets all gates to false when license is suspended', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { gate_key: 'FEATURE_A', default_enabled: true, kill_switch_active: false },
          { gate_key: 'FEATURE_B', default_enabled: true, kill_switch_active: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockGetLicenseStatus.mockResolvedValueOnce({ status: 'suspended', grace_expires_at: new Date() });
    const { getAllGateSnapshot } = await import('../featureGate.js');
    const result = await getAllGateSnapshot('tenant-1', 'product-1');
    expect(result).toEqual({ FEATURE_A: false, FEATURE_B: false });
  });

  it('sets only kill-switched gate to false, leaves others by default', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { gate_key: 'FEATURE_A', default_enabled: true, kill_switch_active: true },
          { gate_key: 'FEATURE_B', default_enabled: true, kill_switch_active: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockGetLicenseStatus.mockResolvedValueOnce({ status: 'active', grace_expires_at: null });
    const { getAllGateSnapshot } = await import('../featureGate.js');
    const result = await getAllGateSnapshot('tenant-1', 'product-1');
    expect(result).toEqual({ FEATURE_A: false, FEATURE_B: true });
  });

  it('returns empty object when no gates registered for product', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockGetLicenseStatus.mockResolvedValueOnce({ status: 'active', grace_expires_at: null });
    const { getAllGateSnapshot } = await import('../featureGate.js');
    const result = await getAllGateSnapshot('tenant-1', 'product-1');
    expect(result).toEqual({});
  });

  it('propagates AppError(404) from getLicenseStatus when license not found', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ gate_key: 'FEATURE_A', default_enabled: true, kill_switch_active: false }],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockGetLicenseStatus.mockRejectedValueOnce(
      Object.assign(new Error('License not found'), { statusCode: 404 }),
    );
    const { getAllGateSnapshot } = await import('../featureGate.js');
    await expect(getAllGateSnapshot('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
