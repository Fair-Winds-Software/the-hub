// Authorized by HUB-692 — unit tests: GET /api/v1/pricing/models/:productId/active; service auth, cache-aside, rate limit
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

const mockBcryptCompare = vi.hoisted(() => vi.fn());
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2b$12$dummyhash'),
    compare: mockBcryptCompare,
  },
}));

const mockRedisGet = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisIncr = vi.hoisted(() => vi.fn());
const mockRedisPexpire = vi.hoisted(() => vi.fn());
const mockRedisPttl = vi.hoisted(() => vi.fn());
vi.mock('../../redis/client.js', () => ({
  getRedisClient: () => ({
    get: mockRedisGet,
    set: mockRedisSet,
    incr: mockRedisIncr,
    pexpire: mockRedisPexpire,
    pttl: mockRedisPttl,
  }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import pricingActiveModelRoutes from '../pricingActiveModelRoutes.js';

const PRODUCT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CLIENT_ID = 'client-id-test';
const CLIENT_SECRET = 'secret-test';

const VALID_HEADERS = {
  'x-client-id': CLIENT_ID,
  'x-client-secret': CLIENT_SECRET,
};

const AUTH_ROW = { client_secret_hash: '$2b$12$hashedvalue' };

const MODEL_ROW = {
  id: 'model-id-1',
  product_id: PRODUCT_ID,
  model_type: 'usage_based',
  config: { unit_price_cents: 10 },
  active: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
};

async function buildTestApp() {
  const fastify = Fastify({ logger: false });
  await fastify.register(pricingActiveModelRoutes);
  return fastify;
}

function setupAuthAndRateLimit() {
  mockPoolQuery.mockResolvedValueOnce({ rows: [AUTH_ROW] });
  mockBcryptCompare.mockResolvedValueOnce(true);
  mockRedisIncr.mockResolvedValueOnce(1);
  mockRedisPexpire.mockResolvedValueOnce(1);
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('GET /api/v1/pricing/models/:productId/active — auth', () => {
  it('returns 401 when x-client-id is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: { 'x-client-secret': CLIENT_SECRET },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when x-client-secret is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: { 'x-client-id': CLIENT_ID },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when client_id not found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    mockBcryptCompare.mockResolvedValueOnce(false);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when secret is wrong', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [AUTH_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(false);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('GET /api/v1/pricing/models/:productId/active — validation', () => {
  it('returns 400 for non-UUID productId', async () => {
    // Rate limit mocks NOT needed — route throws 400 at UUID check before reaching rate limit code
    mockPoolQuery.mockResolvedValueOnce({ rows: [AUTH_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(true);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/pricing/models/not-a-uuid/active',
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});

// ── Rate limit ────────────────────────────────────────────────────────────────

describe('GET /api/v1/pricing/models/:productId/active — rate limit', () => {
  it('returns 429 with Retry-After when rate limit exceeded', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [AUTH_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockRedisIncr.mockResolvedValueOnce(501); // exceeds default max of 500
    mockRedisPexpire.mockResolvedValueOnce(1);
    mockRedisPttl.mockResolvedValueOnce(15000); // 15 seconds
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('15');
    } finally {
      await fastify.close();
    }
  });

  it('proceeds when Redis rate limit check throws (fail-open)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [AUTH_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockRedisIncr.mockRejectedValueOnce(new Error('Redis down'));
    // Cache GET also fails open → DB fallback
    mockRedisGet.mockRejectedValueOnce(new Error('Redis down'));
    mockPoolQuery.mockResolvedValueOnce({ rows: [MODEL_ROW] }); // pricing model
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // tiers
    mockRedisSet.mockRejectedValueOnce(new Error('Redis down')); // cache SET fails too
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await fastify.close();
    }
  });
});

// ── Cache-aside ───────────────────────────────────────────────────────────────

describe('GET /api/v1/pricing/models/:productId/active — cache-aside', () => {
  it('returns cached response when cache is warm', async () => {
    setupAuthAndRateLimit();
    const cachedModel = { id: 'model-id-1', product_id: PRODUCT_ID, model_type: 'usage_based', unit_price_cents: 10, is_active: true, created_at: '2026-01-01T00:00:00.000Z' };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedModel));
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 'model-id-1', model_type: 'usage_based' });
      // DB not called for model fetch (only called once for auth)
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    } finally {
      await fastify.close();
    }
  });

  it('falls back to DB on cache miss and populates cache with EX 5', async () => {
    setupAuthAndRateLimit();
    mockRedisGet.mockResolvedValueOnce(null); // cache miss
    mockPoolQuery.mockResolvedValueOnce({ rows: [MODEL_ROW] }); // pricing model
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // tiers
    mockRedisSet.mockResolvedValueOnce('OK');
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      // Verify SET was called with EX 5
      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining(PRODUCT_ID),
        expect.any(String),
        'EX',
        5,
      );
    } finally {
      await fastify.close();
    }
  });

  it('returns 404 when no active model found', async () => {
    setupAuthAndRateLimit();
    mockRedisGet.mockResolvedValueOnce(null); // cache miss
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no model
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });

  it('does NOT cache 404 results', async () => {
    setupAuthAndRateLimit();
    mockRedisGet.mockResolvedValueOnce(null); // cache miss
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no model
    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(mockRedisSet).not.toHaveBeenCalled();
    } finally {
      await fastify.close();
    }
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe('GET /api/v1/pricing/models/:productId/active — response shape', () => {
  it('returns correct shape for usage_based model', async () => {
    setupAuthAndRateLimit();
    mockRedisGet.mockResolvedValueOnce(null);
    mockPoolQuery.mockResolvedValueOnce({ rows: [MODEL_ROW] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no tiers
    mockRedisSet.mockResolvedValueOnce('OK');
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; product_id: string; model_type: string; unit_price_cents: number; is_active: boolean; created_at: string }>();
      expect(body.id).toBe('model-id-1');
      expect(body.product_id).toBe(PRODUCT_ID);
      expect(body.model_type).toBe('usage_based');
      expect(body.unit_price_cents).toBe(10);
      expect(body.is_active).toBe(true);
      expect(body.created_at).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      await fastify.close();
    }
  });

  it('includes tiers with tier_min_units and tier_max_units for tiered model', async () => {
    setupAuthAndRateLimit();
    mockRedisGet.mockResolvedValueOnce(null);
    const tieredModel = { ...MODEL_ROW, model_type: 'tiered', config: {} };
    mockPoolQuery.mockResolvedValueOnce({ rows: [tieredModel] });
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { tier_order: 1, up_to_units: 100, unit_price_cents: 10 },
        { tier_order: 2, up_to_units: null, unit_price_cents: 5 },
      ],
    });
    mockRedisSet.mockResolvedValueOnce('OK');
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/pricing/models/${PRODUCT_ID}/active`,
        headers: VALID_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ tiers: Array<{ tier_order: number; tier_min_units: number; tier_max_units: number | null }> }>();
      expect(body.tiers).toHaveLength(2);
      expect(body.tiers[0]).toMatchObject({ tier_order: 1, tier_min_units: 0, tier_max_units: 100 });
      expect(body.tiers[1]).toMatchObject({ tier_order: 2, tier_min_units: 101, tier_max_units: null });
    } finally {
      await fastify.close();
    }
  });
});
