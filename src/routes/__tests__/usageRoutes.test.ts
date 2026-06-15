// Authorized by HUB-629 — unit tests: POST /api/v1/usage/events; service auth, rate limit, batch processing
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

const mockRedisIncr = vi.hoisted(() => vi.fn());
const mockRedisPexpire = vi.hoisted(() => vi.fn());
const mockRedisPttl = vi.hoisted(() => vi.fn());
vi.mock('../../redis/client.js', () => ({
  getRedisClient: () => ({
    incr: mockRedisIncr,
    pexpire: mockRedisPexpire,
    pttl: mockRedisPttl,
  }),
}));

const mockRecordUsageEvent = vi.hoisted(() => vi.fn());
vi.mock('../../services/usageTrackingService.js', () => ({
  recordUsageEvent: mockRecordUsageEvent,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import usageRoutes from '../usageRoutes.js';

async function buildTestApp() {
  const fastify = Fastify({ logger: false });
  await fastify.register(usageRoutes);
  return fastify;
}

const VALID_CLIENT_ID = 'client-id-abc';
const VALID_CLIENT_SECRET = 'secret-xyz';
const VALID_HEADERS = {
  'x-client-id': VALID_CLIENT_ID,
  'x-client-secret': VALID_CLIENT_SECRET,
};

const DB_ROW = {
  product_id: 'product-1',
  tenant_id: 'tenant-1',
  client_secret_hash: '$2b$12$hashedvalue',
};

const VALID_EVENT = {
  event_type: 'api_call',
  unit_count: 5,
  occurred_at: new Date().toISOString(),
};

afterEach(() => {
  vi.clearAllMocks();
});

function setupAuthAndRateLimit() {
  mockPoolQuery.mockResolvedValueOnce({ rows: [DB_ROW] });
  mockBcryptCompare.mockResolvedValueOnce(true);
  mockRedisIncr.mockResolvedValueOnce(1);
  mockRedisPexpire.mockResolvedValueOnce(1);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('POST /api/v1/usage/events — auth', () => {
  it('returns 401 when x-client-id header is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: { 'x-client-secret': 'secret' },
        payload: { events: [VALID_EVENT] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when x-client-secret header is missing', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: { 'x-client-id': VALID_CLIENT_ID },
        payload: { events: [VALID_EVENT] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when client_id not found in DB', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    mockBcryptCompare.mockResolvedValueOnce(false);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [VALID_EVENT] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it('returns 401 when client_secret is wrong', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [DB_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(false);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [VALID_EVENT] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe('POST /api/v1/usage/events — rate limiting', () => {
  it('returns 429 with Retry-After header when rate limit exceeded', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [DB_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockRedisIncr.mockResolvedValueOnce(1001); // exceeds default max of 1000
    mockRedisPexpire.mockResolvedValueOnce(1);
    mockRedisPttl.mockResolvedValueOnce(30000); // 30 seconds remaining

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [VALID_EVENT] },
      });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('30');
    } finally {
      await fastify.close();
    }
  });

  it('proceeds when Redis rate limit check throws (fail-open)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [DB_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockRedisIncr.mockRejectedValueOnce(new Error('Redis down'));
    mockRecordUsageEvent.mockResolvedValueOnce({ event_id: 'evt-1', cost_cents: 0, duplicate: false });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [VALID_EVENT] },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await fastify.close();
    }
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('POST /api/v1/usage/events — validation', () => {
  it('returns 400 when events is missing', async () => {
    setupAuthAndRateLimit();
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when events is an empty array', async () => {
    setupAuthAndRateLimit();
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when event_type is missing', async () => {
    setupAuthAndRateLimit();
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [{ unit_count: 5, occurred_at: new Date().toISOString() }] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when unit_count is zero', async () => {
    setupAuthAndRateLimit();
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [{ event_type: 'api_call', unit_count: 0, occurred_at: new Date().toISOString() }] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when occurred_at is not a valid ISO timestamp', async () => {
    setupAuthAndRateLimit();
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [{ event_type: 'api_call', unit_count: 1, occurred_at: 'not-a-date' }] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});

// ── Success and batch processing ──────────────────────────────────────────────

describe('POST /api/v1/usage/events — success', () => {
  it('returns 200 with processed/accepted/duplicates counts', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [DB_ROW] });
    mockBcryptCompare.mockResolvedValueOnce(true);
    mockRedisIncr.mockResolvedValueOnce(1);
    mockRedisPexpire.mockResolvedValueOnce(1);
    mockRecordUsageEvent
      .mockResolvedValueOnce({ event_id: 'evt-1', cost_cents: 999, duplicate: false })
      .mockResolvedValueOnce({ event_id: '', cost_cents: 0, duplicate: true });

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: {
          events: [
            { event_type: 'api_call', unit_count: 1, occurred_at: new Date().toISOString() },
            { event_type: 'api_call', unit_count: 1, occurred_at: new Date().toISOString(), idempotency_key: 'idem-1' },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ processed: number; accepted: number; duplicates: number }>();
      expect(body.processed).toBe(2);
      expect(body.accepted).toBe(1);
      expect(body.duplicates).toBe(1);
    } finally {
      await fastify.close();
    }
  });

  it('passes tenant_id and product_id from auth lookup to service', async () => {
    setupAuthAndRateLimit();
    mockRecordUsageEvent.mockResolvedValueOnce({ event_id: 'evt-1', cost_cents: 0, duplicate: false });

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'POST',
        url: '/api/v1/usage/events',
        headers: VALID_HEADERS,
        payload: { events: [VALID_EVENT] },
      });
      expect(mockRecordUsageEvent).toHaveBeenCalledWith(
        'tenant-1',
        'product-1',
        expect.objectContaining({ event_type: 'api_call', unit_count: 5 }),
      );
    } finally {
      await fastify.close();
    }
  });
});
