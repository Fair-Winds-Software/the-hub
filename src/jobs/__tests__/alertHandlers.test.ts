// Authorized by HUB-719 — unit tests: registerAlertHandlers() creates 4 workers; handlers extract correct fields
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockIngestAlert = vi.hoisted(() => vi.fn());
vi.mock('../../services/alertService.js', () => ({
  ingestAlert: mockIngestAlert,
}));

const MockWorker = vi.hoisted(() =>
  vi.fn().mockImplementation((name: string, _handler: unknown, _opts: unknown) => ({
    name,
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
);
vi.mock('bullmq', () => ({ Worker: MockWorker }));

vi.mock('../../redis/client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerAlertHandlers } from '../alertHandlers.js';

const TENANT_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ALERT_ID   = 'cccccccc-0000-0000-0000-000000000003';

beforeEach(() => {
  vi.resetAllMocks();
  // Restore Worker mock after reset
  MockWorker.mockImplementation((name: string) => ({
    name,
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  }));
});

// ── Worker registration ───────────────────────────────────────────────────────

describe('registerAlertHandlers()', () => {
  it('creates exactly 4 Workers', () => {
    registerAlertHandlers();
    expect(MockWorker).toHaveBeenCalledTimes(4);
  });

  it('creates worker for queue:alerts:below_floor', () => {
    registerAlertHandlers();
    const names = MockWorker.mock.calls.map((c) => c[0] as string);
    expect(names).toContain('queue:alerts:below_floor');
  });

  it('creates worker for queue:alerts:grace_period_expired', () => {
    registerAlertHandlers();
    const names = MockWorker.mock.calls.map((c) => c[0] as string);
    expect(names).toContain('queue:alerts:grace_period_expired');
  });

  it('creates worker for queue:alerts:payment_failed', () => {
    registerAlertHandlers();
    const names = MockWorker.mock.calls.map((c) => c[0] as string);
    expect(names).toContain('queue:alerts:payment_failed');
  });

  it('creates worker for queue:alerts:sdk_version_deprecated', () => {
    registerAlertHandlers();
    const names = MockWorker.mock.calls.map((c) => c[0] as string);
    expect(names).toContain('queue:alerts:sdk_version_deprecated');
  });

  it('all workers are created with concurrency 1', () => {
    registerAlertHandlers();
    for (const call of MockWorker.mock.calls) {
      expect((call[2] as { concurrency: number }).concurrency).toBe(1);
    }
  });

  it('returns array of 4 workers', () => {
    const workers = registerAlertHandlers();
    expect(workers).toHaveLength(4);
  });
});

// ── Handler: below_floor ──────────────────────────────────────────────────────

describe('below_floor handler', () => {
  it('calls ingestAlert with alertType below_floor and correct payload', async () => {
    registerAlertHandlers();
    mockIngestAlert.mockResolvedValueOnce({ alertId: ALERT_ID, isDedup: false, fireCount: 1 });

    const [call] = MockWorker.mock.calls.filter((c) => c[0] === 'queue:alerts:below_floor');
    const handler = call![1] as (job: { data: Record<string, unknown> }) => Promise<void>;
    await handler({ data: { tenantId: TENANT_ID, productId: PRODUCT_ID, marginPercentage: 15, floorPercentage: 20, dedupKey: 'dk-1' } });

    expect(mockIngestAlert).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      alertType: 'below_floor',
      payload: { marginPercentage: 15, floorPercentage: 20 },
      dedupKey: 'dk-1',
    });
  });

  it('D-001: below_floor handler always calls ingestAlert unconditionally', async () => {
    registerAlertHandlers();
    mockIngestAlert.mockResolvedValueOnce({ alertId: ALERT_ID, isDedup: false, fireCount: 1 });

    const [call] = MockWorker.mock.calls.filter((c) => c[0] === 'queue:alerts:below_floor');
    const handler = call![1] as (job: { data: Record<string, unknown> }) => Promise<void>;
    await handler({ data: { tenantId: TENANT_ID, productId: PRODUCT_ID, marginPercentage: 5, floorPercentage: 25 } });

    expect(mockIngestAlert).toHaveBeenCalledTimes(1);
    expect(mockIngestAlert.mock.calls[0]![0].alertType).toBe('below_floor');
  });

  it('re-throws on ingestAlert failure', async () => {
    registerAlertHandlers();
    mockIngestAlert.mockRejectedValueOnce(new Error('DB down'));

    const [call] = MockWorker.mock.calls.filter((c) => c[0] === 'queue:alerts:below_floor');
    const handler = call![1] as (job: { data: Record<string, unknown> }) => Promise<void>;
    await expect(handler({ data: { tenantId: TENANT_ID, productId: PRODUCT_ID, marginPercentage: 10, floorPercentage: 20 } }))
      .rejects.toThrow('DB down');
  });
});

// ── Handler: grace_period_expired ────────────────────────────────────────────

describe('grace_period_expired handler', () => {
  it('calls ingestAlert with correct alertType and payload', async () => {
    registerAlertHandlers();
    mockIngestAlert.mockResolvedValueOnce({ alertId: ALERT_ID, isDedup: false, fireCount: 1 });

    const [call] = MockWorker.mock.calls.filter((c) => c[0] === 'queue:alerts:grace_period_expired');
    const handler = call![1] as (job: { data: Record<string, unknown> }) => Promise<void>;
    await handler({ data: { tenantId: TENANT_ID, productId: PRODUCT_ID, leaseId: 'lease-1', expiredAt: '2026-06-01T00:00:00Z' } });

    expect(mockIngestAlert).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'grace_period_expired',
      payload: { leaseId: 'lease-1', expiredAt: '2026-06-01T00:00:00Z' },
    }));
  });
});

// ── Handler: payment_failed ───────────────────────────────────────────────────

describe('payment_failed handler', () => {
  it('calls ingestAlert with correct alertType and payload', async () => {
    registerAlertHandlers();
    mockIngestAlert.mockResolvedValueOnce({ alertId: ALERT_ID, isDedup: false, fireCount: 1 });

    const [call] = MockWorker.mock.calls.filter((c) => c[0] === 'queue:alerts:payment_failed');
    const handler = call![1] as (job: { data: Record<string, unknown> }) => Promise<void>;
    await handler({ data: { tenantId: TENANT_ID, productId: PRODUCT_ID, stripeInvoiceId: 'inv_123', failureReason: 'card_declined' } });

    expect(mockIngestAlert).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'payment_failed',
      payload: { stripeInvoiceId: 'inv_123', failureReason: 'card_declined' },
    }));
  });
});

// ── Handler: sdk_version_deprecated ──────────────────────────────────────────

describe('sdk_version_deprecated handler', () => {
  it('calls ingestAlert with correct alertType and payload', async () => {
    registerAlertHandlers();
    mockIngestAlert.mockResolvedValueOnce({ alertId: ALERT_ID, isDedup: false, fireCount: 1 });

    const [call] = MockWorker.mock.calls.filter((c) => c[0] === 'queue:alerts:sdk_version_deprecated');
    const handler = call![1] as (job: { data: Record<string, unknown> }) => Promise<void>;
    await handler({ data: { tenantId: TENANT_ID, productId: PRODUCT_ID, sdkVersion: '1.2.3', deprecatedAt: '2026-06-01T00:00:00Z' } });

    expect(mockIngestAlert).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'sdk_version_deprecated',
      payload: { sdkVersion: '1.2.3', deprecatedAt: '2026-06-01T00:00:00Z' },
    }));
  });
});
