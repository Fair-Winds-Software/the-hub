// Authorized by HUB-1707 — unit tests for the automated compat-window flip.
//   Covers AC 2 (both trigger paths: 30-min quiet + 24h elapsed), AC 3 (residual alert
//   path without flip), AC 4 (idempotent early return when flag already false), and
//   the first-tick self-seeding behavior of the started_at Redis key.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockRedisIncr = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisGet = vi.hoisted(() => vi.fn());
const mockRedisDel = vi.hoisted(() => vi.fn());
vi.mock('../../redis/client.js', () => ({
  getRedisClient: () => ({
    incr: mockRedisIncr,
    set: mockRedisSet,
    get: mockRedisGet,
    del: mockRedisDel,
  }),
}));

const mockGetSetting = vi.hoisted(() => vi.fn());
const mockUpdateSetting = vi.hoisted(() => vi.fn());
vi.mock('../adminSettings.js', () => ({
  getSetting: mockGetSetting,
  updateSetting: mockUpdateSetting,
}));

const mockWriteAuditEntry = vi.hoisted(() => vi.fn());
vi.mock('../auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

const mockDeliverAlert = vi.hoisted(() => vi.fn());
vi.mock('../complianceAlertService.js', () => ({
  deliverAlert: mockDeliverAlert,
}));

const mockRemoveRepeatable = vi.hoisted(() => vi.fn());
vi.mock('../../queues/index.js', () => ({
  getRoleRenameCompatFlipQueue: () => ({ removeRepeatable: mockRemoveRepeatable }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  incrementLegacyClaimCounter,
  runRoleRenameCompatFlip,
  QUIET_WINDOW_MS,
  MAX_WINDOW_MS,
} from '../roleRenameCompatService.js';

const NOW = Date.parse('2026-07-05T12:00:00Z');
const START = Date.parse('2026-07-05T00:00:00Z');
const HUB_INTERNAL_TENANT_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisIncr.mockResolvedValue(1);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockUpdateSetting.mockResolvedValue({ key: 'role_rename_compat_window_enabled', value: false, updated_at: new Date().toISOString() });
  mockWriteAuditEntry.mockResolvedValue(undefined);
  mockDeliverAlert.mockResolvedValue({ notification_id: 'test-note', duplicate: false });
  mockRemoveRepeatable.mockResolvedValue(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 1 — telemetry counter
// ─────────────────────────────────────────────────────────────────────────────

describe('incrementLegacyClaimCounter (AC 1)', () => {
  it('INCRs the counter key and SETs last_at', async () => {
    await incrementLegacyClaimCounter();
    expect(mockRedisIncr).toHaveBeenCalledWith('metrics:jwt.legacy_claim_accepted');
    expect(mockRedisSet).toHaveBeenCalledWith(
      'metrics:jwt.legacy_claim_accepted:last_at',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('does not throw when Redis is unreachable — telemetry is fire-and-forget', async () => {
    mockRedisIncr.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(incrementLegacyClaimCounter()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 4 — idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('runRoleRenameCompatFlip idempotency (AC 4)', () => {
  it('returns noop when the flag is already false — no reads, no side effects', async () => {
    mockGetSetting.mockResolvedValueOnce(false);
    const res = await runRoleRenameCompatFlip(NOW);
    expect(res).toEqual({ action: 'noop' });
    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockUpdateSetting).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(mockDeliverAlert).not.toHaveBeenCalled();
    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-seeding — first tick with flag=true and started_at unset
// ─────────────────────────────────────────────────────────────────────────────

describe('runRoleRenameCompatFlip self-seed', () => {
  it('seeds started_at on first tick and returns wait', async () => {
    mockGetSetting.mockResolvedValueOnce(true);
    mockRedisGet.mockResolvedValueOnce(null); // started_at not set
    const res = await runRoleRenameCompatFlip(NOW);
    expect(res).toEqual({ action: 'wait' });
    expect(mockRedisSet).toHaveBeenCalledWith(
      'metrics:role_rename_compat_window:started_at',
      new Date(NOW).toISOString(),
    );
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 2 — flip trigger: no legacy claims for 30 min
// ─────────────────────────────────────────────────────────────────────────────

describe('runRoleRenameCompatFlip (AC 2: no_legacy_claims_30m)', () => {
  it('flips when window age ≥30m and last_at ≥30m ago', async () => {
    mockGetSetting.mockResolvedValueOnce(true);
    const startedAtIso = new Date(NOW - QUIET_WINDOW_MS - 60_000).toISOString();
    const lastAtIso = new Date(NOW - QUIET_WINDOW_MS - 30_000).toISOString();
    mockRedisGet
      .mockResolvedValueOnce(startedAtIso) // started_at
      .mockResolvedValueOnce('3')          // counter
      .mockResolvedValueOnce(lastAtIso);   // last_at

    const res = await runRoleRenameCompatFlip(NOW);
    expect(res).toEqual({ action: 'flip', trigger: 'no_legacy_claims_30m' });

    expect(mockUpdateSetting).toHaveBeenCalledWith('role_rename_compat_window_enabled', false);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: HUB_INTERNAL_TENANT_ID,
      actor_type: 'system',
      actor_id: 'role-rename-window-closed',
      operation: 'UPDATE',
      table_name: 'settings',
      record_id: 'role_rename_compat_window_enabled',
      old_values: { value: true },
      new_values: expect.objectContaining({
        value: false,
        trigger: 'no_legacy_claims_30m',
        started_at: startedAtIso,
        counter_at_flip: 3,
      }),
    }));

    expect(mockRedisDel).toHaveBeenCalledWith(
      'metrics:jwt.legacy_claim_accepted',
      'metrics:jwt.legacy_claim_accepted:last_at',
      'metrics:role_rename_compat_window:started_at',
    );
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'role-rename-compat-flip',
      { pattern: '*/5 * * * *' },
    );
  });

  it('flips when window age ≥30m and last_at is null (never incremented)', async () => {
    mockGetSetting.mockResolvedValueOnce(true);
    const startedAtIso = new Date(NOW - QUIET_WINDOW_MS - 60_000).toISOString();
    mockRedisGet
      .mockResolvedValueOnce(startedAtIso) // started_at
      .mockResolvedValueOnce(null)          // counter missing = 0
      .mockResolvedValueOnce(null);         // last_at missing

    const res = await runRoleRenameCompatFlip(NOW);
    expect(res).toEqual({ action: 'flip', trigger: 'no_legacy_claims_30m' });
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      new_values: expect.objectContaining({ counter_at_flip: 0 }),
    }));
  });

  it('waits when window age <30m even if last_at is old', async () => {
    mockGetSetting.mockResolvedValueOnce(true);
    const startedAtIso = new Date(NOW - 10 * 60_000).toISOString(); // 10 min ago
    mockRedisGet
      .mockResolvedValueOnce(startedAtIso)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const res = await runRoleRenameCompatFlip(NOW);
    expect(res).toEqual({ action: 'wait' });
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it('waits when quiet duration <30m', async () => {
    mockGetSetting.mockResolvedValueOnce(true);
    const startedAtIso = new Date(START).toISOString(); // ~12h ago
    const lastAtIso = new Date(NOW - 5 * 60_000).toISOString(); // 5 min ago
    mockRedisGet
      .mockResolvedValueOnce(startedAtIso)
      .mockResolvedValueOnce('7')
      .mockResolvedValueOnce(lastAtIso);

    const res = await runRoleRenameCompatFlip(NOW);
    expect(res).toEqual({ action: 'wait' });
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 2 — flip trigger: 24h elapsed
// ─────────────────────────────────────────────────────────────────────────────

describe('runRoleRenameCompatFlip (AC 2: 24h_elapsed)', () => {
  it('flips when age ≥24h and counter is 0', async () => {
    mockGetSetting.mockResolvedValueOnce(true);
    const startedAtIso = new Date(NOW - MAX_WINDOW_MS - 60_000).toISOString();
    mockRedisGet
      .mockResolvedValueOnce(startedAtIso)
      .mockResolvedValueOnce('0')
      .mockResolvedValueOnce(null);

    const res = await runRoleRenameCompatFlip(NOW);
    expect(res).toEqual({ action: 'flip', trigger: '24h_elapsed' });
    expect(mockUpdateSetting).toHaveBeenCalledWith('role_rename_compat_window_enabled', false);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      new_values: expect.objectContaining({ trigger: '24h_elapsed', counter_at_flip: 0 }),
    }));
    expect(mockDeliverAlert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC 3 — residual alert path
// ─────────────────────────────────────────────────────────────────────────────

describe('runRoleRenameCompatFlip residual (AC 3)', () => {
  it('emits residual alert and does NOT flip when age ≥24h and counter >0', async () => {
    mockGetSetting.mockResolvedValueOnce(true);
    const startedAtIso = new Date(NOW - MAX_WINDOW_MS - 60_000).toISOString();
    const lastAtIso = new Date(NOW - 60_000).toISOString();
    mockRedisGet
      .mockResolvedValueOnce(startedAtIso)
      .mockResolvedValueOnce('5')
      .mockResolvedValueOnce(lastAtIso);

    const res = await runRoleRenameCompatFlip(NOW);
    expect(res).toEqual({ action: 'residual_alert' });

    expect(mockUpdateSetting).not.toHaveBeenCalled();
    expect(mockRedisDel).not.toHaveBeenCalled();
    expect(mockRemoveRepeatable).not.toHaveBeenCalled();

    expect(mockDeliverAlert).toHaveBeenCalledWith({
      alertType: 'residual_legacy_claim_after_window',
      severity: 'high',
      payload: expect.objectContaining({
        counter: 5,
        started_at: startedAtIso,
        last_legacy_claim_at: lastAtIso,
      }),
      contentHashSeed: `residual_legacy_claim_after_window:${startedAtIso}`,
    });
  });

  it('deduplicates by contentHashSeed derived from started_at — re-firing the CRON does not spam', async () => {
    mockGetSetting.mockResolvedValue(true);
    const startedAtIso = new Date(NOW - MAX_WINDOW_MS - 60_000).toISOString();
    mockRedisGet
      .mockResolvedValue(startedAtIso)
      .mockResolvedValueOnce(startedAtIso).mockResolvedValueOnce('5').mockResolvedValueOnce(null)
      .mockResolvedValueOnce(startedAtIso).mockResolvedValueOnce('7').mockResolvedValueOnce(null);

    await runRoleRenameCompatFlip(NOW);
    await runRoleRenameCompatFlip(NOW + 5 * 60_000);

    const seeds = mockDeliverAlert.mock.calls.map((c) => (c[0] as { contentHashSeed: string }).contentHashSeed);
    expect(new Set(seeds).size).toBe(1);
    expect(seeds[0]).toBe(`residual_legacy_claim_after_window:${startedAtIso}`);
  });
});
