// Authorized by HUB-580 — unit tests: activatePricingModel
// Authorized by HUB-581 — unit tests: getActivePricingModel, getPricingModelHistory
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockClientQuery = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());

vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: mockConnect }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRedisGet = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisPublish = vi.hoisted(() => vi.fn());
vi.mock('../../redis/client.js', () => ({
  getRedisClient: () => ({
    get: mockRedisGet,
    set: mockRedisSet,
    publish: mockRedisPublish,
  }),
}));

const mockValidate = vi.hoisted(() => vi.fn());
vi.mock('../../lib/pricingModelValidation.js', () => ({
  validatePricingModelConfig: mockValidate,
}));

import {
  activatePricingModel,
  getActivePricingModel,
  getPricingModelHistory,
} from '../pricingModelService.js';
import { AppError } from '../../errors/AppError.js';

const mockClient = { query: mockClientQuery, release: mockRelease };

const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeModelRow(overrides = {}) {
  return {
    id: 'model-1',
    product_id: 'product-1',
    model_type: 'flat_rate',
    currency: 'USD',
    config: { price_cents: 999 },
    active: true,
    activated_at: NOW,
    deprecated_at: null,
    created_by: 'op-1',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(mockClient);
  mockClientQuery.mockResolvedValue({ rows: [] });
  mockPoolQuery.mockResolvedValue({ rows: [] });
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisPublish.mockResolvedValue(1);
});

// ── activatePricingModel ──────────────────────────────────────────────────────

describe('activatePricingModel()', () => {
  it('calls validatePricingModelConfig before any DB work', async () => {
    mockValidate.mockImplementationOnce(() => {
      throw new AppError(400, 'validation failed');
    });

    await expect(
      activatePricingModel('product-1', 'flat_rate', 'USD', {}, undefined, 'op-1'),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('throws AppError(404) when product not found', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT product — not found

    await expect(
      activatePricingModel('product-1', 'flat_rate', 'USD', { price_cents: 999 }, undefined, 'op-1'),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('inserts model, commits, updates Redis, returns model without tiers', async () => {
    const modelRow = makeModelRow();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'product-1' }] }) // SELECT product FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE existing active models
      .mockResolvedValueOnce({ rows: [modelRow] }) // INSERT pricing_model
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await activatePricingModel(
      'product-1',
      'flat_rate',
      'USD',
      { price_cents: 999 },
      undefined,
      'op-1',
    );

    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
    expect(result.model_id).toBe('model-1');
    expect(result.active).toBe(true);
    expect(result.tiers).toEqual([]);
    expect(mockRedisSet).toHaveBeenCalled();
    expect(mockRedisPublish).toHaveBeenCalled();
  });

  it('inserts model with tiers and returns them', async () => {
    const modelRow = makeModelRow({ model_type: 'tiered', config: {} });
    const tierRow = {
      id: 'tier-1',
      model_id: 'model-1',
      tier_order: 0,
      up_to_units: null,
      unit_price_cents: 50,
      flat_fee_cents: 0,
    };
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'product-1' }] }) // SELECT product FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE existing active
      .mockResolvedValueOnce({ rows: [modelRow] }) // INSERT model
      .mockResolvedValueOnce({ rows: [tierRow] }) // INSERT tier
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const tiers = [{ tier_order: 0, up_to_units: null, unit_price_cents: 50, flat_fee_cents: 0 }];
    const result = await activatePricingModel('product-1', 'tiered', 'USD', {}, tiers, 'op-1');

    expect(result.tiers).toHaveLength(1);
    expect(result.tiers![0]!.tier_id).toBe('tier-1');
  });

  it('rolls back and rethrows on DB error', async () => {
    const dbErr = new Error('DB fail');
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'product-1' }] }) // SELECT product
      .mockRejectedValueOnce(dbErr); // UPDATE throws

    await expect(
      activatePricingModel('product-1', 'flat_rate', 'USD', {}, undefined, 'op-1'),
    ).rejects.toThrow(dbErr);

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('swallows Redis failure after successful commit', async () => {
    const modelRow = makeModelRow();
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'product-1' }] }) // SELECT product
      .mockResolvedValueOnce({ rows: [] }) // UPDATE active
      .mockResolvedValueOnce({ rows: [modelRow] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    mockRedisSet.mockRejectedValueOnce(new Error('Redis down'));

    const result = await activatePricingModel(
      'product-1',
      'flat_rate',
      'USD',
      {},
      undefined,
      'op-1',
    );

    expect(result.model_id).toBe('model-1');
  });
});

// ── getActivePricingModel ─────────────────────────────────────────────────────

describe('getActivePricingModel()', () => {
  it('returns parsed model from Redis cache hit', async () => {
    const cached = { model_id: 'model-1', product_id: 'product-1', model_type: 'flat_rate' };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

    const result = await getActivePricingModel('product-1');

    expect(result).toEqual(cached);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('falls back to DB on Redis miss and populates cache', async () => {
    const modelRow = makeModelRow();
    mockRedisGet.mockResolvedValueOnce(null);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [modelRow] }) // SELECT active model
      .mockResolvedValueOnce({ rows: [] }); // SELECT tiers

    const result = await getActivePricingModel('product-1');

    expect(result).not.toBeNull();
    expect(result!.model_id).toBe('model-1');
    expect(mockRedisSet).toHaveBeenCalled();
  });

  it('returns null when no active model exists', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getActivePricingModel('product-1');

    expect(result).toBeNull();
  });

  it('falls back to DB when Redis throws', async () => {
    mockRedisGet.mockRejectedValueOnce(new Error('Redis down'));
    const modelRow = makeModelRow();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [modelRow] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getActivePricingModel('product-1');

    expect(result).not.toBeNull();
  });

  it('includes tiers from DB when present', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    const modelRow = makeModelRow({ model_type: 'tiered', config: {} });
    const tierRow = {
      id: 'tier-1',
      model_id: 'model-1',
      tier_order: 0,
      up_to_units: null,
      unit_price_cents: 50,
      flat_fee_cents: 0,
    };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [modelRow] })
      .mockResolvedValueOnce({ rows: [tierRow] });

    const result = await getActivePricingModel('product-1');

    expect(result!.tiers).toHaveLength(1);
    expect(result!.tiers![0]!.tier_id).toBe('tier-1');
  });
});

// ── getPricingModelHistory ────────────────────────────────────────────────────

describe('getPricingModelHistory()', () => {
  it('returns paginated history with limit and offset', async () => {
    const rows = [makeModelRow({ active: false }), makeModelRow({ id: 'model-2', active: true })];
    mockPoolQuery.mockResolvedValueOnce({ rows });

    const result = await getPricingModelHistory('product-1', 20, 0);

    expect(result.data).toHaveLength(2);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(mockPoolQuery.mock.calls[0]![1]).toEqual(['product-1', 20, 0]);
  });

  it('returns empty data array when no models exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPricingModelHistory('product-1', 20, 0);

    expect(result.data).toEqual([]);
  });
});
