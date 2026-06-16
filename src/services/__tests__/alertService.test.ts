// Authorized by HUB-707 — unit tests: ingestAlert() severity classification, dedup upsert, queue enqueue
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockClientQuery = vi.hoisted(() => vi.fn());
const mockClientRelease = vi.hoisted(() => vi.fn());
const mockPoolConnect = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ connect: mockPoolConnect }),
}));

const mockQueueAdd = vi.hoisted(() => vi.fn());
const mockGetNotificationsDeliverQueue = vi.hoisted(() => vi.fn());
vi.mock('../../queues/index.js', () => ({
  getNotificationsDeliverQueue: mockGetNotificationsDeliverQueue,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ingestAlert } from '../alertService.js';

const TENANT_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ALERT_ID   = 'cccccccc-0000-0000-0000-000000000003';

function setupClientMock(rows: Array<{ id: string; fire_count: number }>) {
  mockPoolConnect.mockResolvedValueOnce({
    query: mockClientQuery.mockResolvedValueOnce({ rows }),
    release: mockClientRelease,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGetNotificationsDeliverQueue.mockReturnValue({ add: mockQueueAdd });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('ingestAlert() — validation', () => {
  it('throws 400 for unknown alertType before any DB call', async () => {
    await expect(
      ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'mystery_alert', payload: {} }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Unknown alert type: mystery_alert') });
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('throws 400 for invalid tenantId UUID', async () => {
    await expect(
      ingestAlert({ tenantId: 'bad-id', productId: PRODUCT_ID, alertType: 'below_floor', payload: {} }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it('throws 400 for invalid productId UUID', async () => {
    await expect(
      ingestAlert({ tenantId: TENANT_ID, productId: 'bad-id', alertType: 'payment_failed', payload: {} }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });
});

// ── Severity classification ───────────────────────────────────────────────────

describe('ingestAlert() — severity classification', () => {
  it('classifies below_floor as warning', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', payload: {} });
    const sql: string = mockClientQuery.mock.calls[0]![0] as string;
    const params = mockClientQuery.mock.calls[0]![1] as unknown[];
    expect(sql).toContain('INSERT INTO alert_events');
    expect(params[3]).toBe('warning');
  });

  it('classifies grace_period_expired as critical', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'grace_period_expired', payload: {} });
    const params = mockClientQuery.mock.calls[0]![1] as unknown[];
    expect(params[3]).toBe('critical');
  });

  it('classifies payment_failed as critical', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'payment_failed', payload: {} });
    const params = mockClientQuery.mock.calls[0]![1] as unknown[];
    expect(params[3]).toBe('critical');
  });

  it('classifies sdk_version_deprecated as info', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'sdk_version_deprecated', payload: {} });
    const params = mockClientQuery.mock.calls[0]![1] as unknown[];
    expect(params[3]).toBe('info');
  });
});

// ── D-001: below_floor always persisted ──────────────────────────────────────

describe('ingestAlert() — D-001 invariant', () => {
  it('below_floor always reaches the DB insert/upsert; never short-circuits', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', payload: { marginPercentage: 10, floorPercentage: 20 } });
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    const sql: string = mockClientQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('INSERT INTO alert_events');
  });
});

// ── Insert vs dedup ───────────────────────────────────────────────────────────

describe('ingestAlert() — new insert', () => {
  it('returns isDedup=false and fireCount=1 on first insert', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    const result = await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', payload: {} });
    expect(result).toEqual({ alertId: ALERT_ID, isDedup: false, fireCount: 1 });
  });

  it('passes null dedup_key when dedupKey not provided', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', payload: {} });
    const params = mockClientQuery.mock.calls[0]![1] as unknown[];
    expect(params[5]).toBeNull();
  });

  it('passes dedupKey as $6 param when provided', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', payload: {}, dedupKey: 'key-abc' });
    const params = mockClientQuery.mock.calls[0]![1] as unknown[];
    expect(params[5]).toBe('key-abc');
  });
});

describe('ingestAlert() — dedup upsert', () => {
  it('returns isDedup=true and fireCount>1 when fire_count returned is 2', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 2 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    const result = await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', payload: {}, dedupKey: 'key-abc' });
    expect(result).toEqual({ alertId: ALERT_ID, isDedup: true, fireCount: 2 });
  });
});

// ── Queue enqueue ─────────────────────────────────────────────────────────────

describe('ingestAlert() — queue enqueue', () => {
  it('enqueues exactly one deliver job after DB write', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockResolvedValueOnce(undefined);
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'payment_failed', payload: { stripeInvoiceId: 'inv_1' } });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith('deliver', expect.objectContaining({
      alertId: ALERT_ID,
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      alertType: 'payment_failed',
      severity: 'critical',
    }));
  });

  it('returns result even when queue enqueue fails (fail-safe)', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockRejectedValueOnce(new Error('Redis down'));
    const result = await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', payload: {} });
    expect(result.alertId).toBe(ALERT_ID);
  });

  it('releases DB client even when queue enqueue fails', async () => {
    setupClientMock([{ id: ALERT_ID, fire_count: 1 }]);
    mockQueueAdd.mockRejectedValueOnce(new Error('Redis down'));
    await ingestAlert({ tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', payload: {} });
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });
});
