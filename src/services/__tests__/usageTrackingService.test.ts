// Authorized by HUB-622 — unit tests: recordUsageEvent; idempotency, cost, late detection
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockClientQuery = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());

vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ connect: mockConnect }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetActivePricingModel = vi.hoisted(() => vi.fn());
vi.mock('../pricingModelService.js', () => ({
  getActivePricingModel: mockGetActivePricingModel,
}));

import { recordUsageEvent } from '../usageTrackingService.js';

const mockClient = { query: mockClientQuery, release: mockRelease };

const FLAT_RATE_MODEL = {
  model_id: 'model-1',
  product_id: 'product-1',
  model_type: 'flat_rate',
  currency: 'USD',
  config: { price_cents: 2999 },
  active: true,
  activated_at: '2026-01-01T00:00:00.000Z',
  deprecated_at: null,
  created_by: 'op-1',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  tiers: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(mockClient);
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockGetActivePricingModel.mockResolvedValue(null);
});

// ── Successful event recording ────────────────────────────────────────────────

describe('recordUsageEvent() — success', () => {
  it('returns event_id, cost_cents, and duplicate: false on new event', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] }) // INSERT usage_event
      .mockResolvedValueOnce({ rows: [] }) // INSERT cost_ledger
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await recordUsageEvent('tenant-1', 'product-1', {
      event_type: 'api_call',
      unit_count: 10,
      occurred_at: new Date().toISOString(),
    });

    expect(result.event_id).toBe('evt-1');
    expect(result.cost_cents).toBe(0);
    expect(result.duplicate).toBe(false);
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('computes cost from active pricing model', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(FLAT_RATE_MODEL);
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'evt-2' }] }) // INSERT usage_event
      .mockResolvedValueOnce({ rows: [] }) // INSERT cost_ledger
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await recordUsageEvent('tenant-1', 'product-1', {
      event_type: 'api_call',
      unit_count: 5,
      occurred_at: new Date().toISOString(),
    });

    expect(result.cost_cents).toBe(2999);
    expect(result.duplicate).toBe(false);
  });

  it('passes pricing_model_id=null to cost_ledger when no active model', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(null);
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'evt-3' }] }) // INSERT usage_event
      .mockResolvedValueOnce({ rows: [] }) // INSERT cost_ledger
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await recordUsageEvent('tenant-1', 'product-1', {
      event_type: 'api_call',
      unit_count: 1,
      occurred_at: new Date().toISOString(),
    });

    expect(result.cost_cents).toBe(0);
    const costInsertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cost_ledger'),
    );
    expect(costInsertCall).toBeDefined();
    expect(costInsertCall![1][3]).toBeNull(); // pricing_model_id param
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('recordUsageEvent() — idempotency', () => {
  it('returns duplicate: true when idempotency_key conflicts', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // INSERT ON CONFLICT DO NOTHING → no row
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const result = await recordUsageEvent('tenant-1', 'product-1', {
      event_type: 'api_call',
      unit_count: 1,
      occurred_at: new Date().toISOString(),
      idempotency_key: 'idem-key-123',
    });

    expect(result.duplicate).toBe(true);
    expect(result.event_id).toBe('');
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});

// ── Late detection ────────────────────────────────────────────────────────────

describe('recordUsageEvent() — ingested_late flag', () => {
  it('sets ingested_late=true for events older than 24 hours', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'evt-late' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // INSERT cost_ledger
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await recordUsageEvent('tenant-1', 'product-1', {
      event_type: 'api_call',
      unit_count: 1,
      occurred_at: twoDaysAgo,
    });

    const insertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO usage_events'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][5]).toBe(true); // ingested_late param index
  });

  it('sets ingested_late=false for recent events', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'evt-fresh' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }) // INSERT cost_ledger
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const justNow = new Date().toISOString();
    await recordUsageEvent('tenant-1', 'product-1', {
      event_type: 'api_call',
      unit_count: 1,
      occurred_at: justNow,
    });

    const insertCall = mockClientQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO usage_events'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][5]).toBe(false); // ingested_late param index
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('recordUsageEvent() — error handling', () => {
  it('rolls back and rethrows on DB error', async () => {
    const dbErr = new Error('DB fail');
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(dbErr); // INSERT throws

    await expect(
      recordUsageEvent('tenant-1', 'product-1', {
        event_type: 'api_call',
        unit_count: 1,
        occurred_at: new Date().toISOString(),
      }),
    ).rejects.toThrow(dbErr);

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});
