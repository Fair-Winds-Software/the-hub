// Authorized by HUB-594 — unit tests: POST + GET /api/v1/pricing/models/:productId
// Authorized by HUB-595 — unit tests: GET /api/v1/pricing/models/:productId/history
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockActivatePricingModel = vi.hoisted(() => vi.fn());
const mockGetActivePricingModel = vi.hoisted(() => vi.fn());
const mockGetPricingModelHistory = vi.hoisted(() => vi.fn());

vi.mock('../../services/pricingModelService.js', () => ({
  activatePricingModel: mockActivatePricingModel,
  getActivePricingModel: mockGetActivePricingModel,
  getPricingModelHistory: mockGetPricingModelHistory,
}));

import pricingModelRoutes from '../pricingModelRoutes.js';

async function buildTestApp() {
  const fastify = Fastify({ logger: false });
  fastify.decorate(
    'authenticateOperator',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      request.operator_id = 'op-1';
      request.operator_role = 'admin';
    },
  );
  await fastify.register(pricingModelRoutes);
  return fastify;
}

afterEach(() => {
  vi.clearAllMocks();
});

const VALID_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';

const SAMPLE_MODEL = {
  model_id: 'model-1',
  product_id: VALID_UUID,
  model_type: 'flat_rate',
  currency: 'USD',
  config: { price_cents: 999 },
  active: true,
  activated_at: '2026-01-01T00:00:00.000Z',
  deprecated_at: null,
  created_by: 'op-1',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  tiers: [],
};

// ── POST /api/v1/pricing/models/:productId ────────────────────────────────────

describe('POST /api/v1/pricing/models/:productId', () => {
  it('returns 200 with activated model', async () => {
    mockActivatePricingModel.mockResolvedValueOnce(SAMPLE_MODEL);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/models/${VALID_UUID}`,
        payload: { model_type: 'flat_rate', config: { price_cents: 999 } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: typeof SAMPLE_MODEL }>();
      expect(body.data.model_id).toBe('model-1');
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when productId is not a valid UUID', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/pricing/models/not-a-uuid',
        payload: { model_type: 'flat_rate' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when model_type is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/models/${VALID_UUID}`,
        payload: { config: { price_cents: 999 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when config is not an object', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/models/${VALID_UUID}`,
        payload: { model_type: 'flat_rate', config: 'not-an-object' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('passes operator_id to service', async () => {
    mockActivatePricingModel.mockResolvedValueOnce(SAMPLE_MODEL);

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/models/${VALID_UUID}`,
        payload: { model_type: 'flat_rate', config: { price_cents: 999 } },
      });
      expect(mockActivatePricingModel).toHaveBeenCalledWith(
        VALID_UUID,
        'flat_rate',
        'USD',
        { price_cents: 999 },
        undefined,
        'op-1',
      );
    } finally {
      await fastify.close();
    }
  });

  it('uses provided currency when given', async () => {
    mockActivatePricingModel.mockResolvedValueOnce(SAMPLE_MODEL);

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/models/${VALID_UUID}`,
        payload: { model_type: 'flat_rate', currency: 'GBP', config: { price_cents: 999 } },
      });
      expect(mockActivatePricingModel).toHaveBeenCalledWith(
        VALID_UUID,
        'flat_rate',
        'GBP',
        { price_cents: 999 },
        undefined,
        'op-1',
      );
    } finally {
      await fastify.close();
    }
  });

  it('propagates AppError(404) from service', async () => {
    const { AppError } = await import('../../errors/AppError.js');
    mockActivatePricingModel.mockRejectedValueOnce(new AppError(404, 'Product not found'));

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/pricing/models/${VALID_UUID}`,
        payload: { model_type: 'flat_rate' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });
});

// ── GET /api/v1/pricing/models/:productId ────────────────────────────────────

describe('GET /api/v1/pricing/models/:productId', () => {
  it('returns 200 with active model', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(SAMPLE_MODEL);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: typeof SAMPLE_MODEL }>();
      expect(body.data.model_id).toBe('model-1');
    } finally {
      await fastify.close();
    }
  });

  it('returns 404 when no active model exists', async () => {
    mockGetActivePricingModel.mockResolvedValueOnce(null);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when productId is not a valid UUID', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/pricing/models/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});

// ── GET /api/v1/pricing/models/:productId/history ─────────────────────────────

describe('GET /api/v1/pricing/models/:productId/history', () => {
  it('returns 200 with paginated history', async () => {
    const historyResult = { data: [SAMPLE_MODEL], limit: 20, offset: 0 };
    mockGetPricingModelHistory.mockResolvedValueOnce(historyResult);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${VALID_UUID}/history`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<typeof historyResult>();
      expect(body.data).toHaveLength(1);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
    } finally {
      await fastify.close();
    }
  });

  it('passes limit and offset from query params', async () => {
    mockGetPricingModelHistory.mockResolvedValueOnce({ data: [], limit: 5, offset: 10 });

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${VALID_UUID}/history?limit=5&offset=10`,
      });
      expect(mockGetPricingModelHistory).toHaveBeenCalledWith(VALID_UUID, 5, 10);
    } finally {
      await fastify.close();
    }
  });

  it('caps limit at 100', async () => {
    mockGetPricingModelHistory.mockResolvedValueOnce({ data: [], limit: 100, offset: 0 });

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${VALID_UUID}/history?limit=999`,
      });
      expect(mockGetPricingModelHistory).toHaveBeenCalledWith(VALID_UUID, 100, 0);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when productId is not a valid UUID', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/pricing/models/not-a-uuid/history',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});
