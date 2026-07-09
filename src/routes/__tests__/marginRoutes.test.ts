// Authorized by HUB-657 — unit tests: POST + GET /api/v1/pricing/margin-config/:productId; operator auth; validation
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import marginRoutes from '../marginRoutes.js';

import { closeAppResources } from '../../__tests__/_testCleanup.js';
// ── Test app ──────────────────────────────────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();

  // Minimal mock of authenticateOperator decorator
  (app as any).decorate('authenticateOperator', async (request: any) => {
    request.operator_id = 'test-operator-id';
  });

  await app.register(marginRoutes);
  await app.ready();
});

afterAll(async () => {
  await closeAppResources(app);
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── POST validation ───────────────────────────────────────────────────────────

describe('POST /api/v1/pricing/margin-config/:productId — validation', () => {
  it('returns 400 when productId is not a valid UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricing/margin-config/not-a-uuid',
      body: { floor_percentage: 30, alert_threshold_percentage: 40, enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when body is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when floor_percentage is not a number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: '30', alert_threshold_percentage: 40, enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when alert_threshold_percentage is not a number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: 30, alert_threshold_percentage: '40', enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when enabled is not a boolean', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: 30, alert_threshold_percentage: 40, enabled: 'true' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when floor_percentage is below 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: -1, alert_threshold_percentage: 40, enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when floor_percentage exceeds 100', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: 101, alert_threshold_percentage: 40, enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when alert_threshold_percentage exceeds 100', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: 30, alert_threshold_percentage: 110, enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── POST success ──────────────────────────────────────────────────────────────

describe('POST /api/v1/pricing/margin-config/:productId — success', () => {
  it('returns 200 with upserted config', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          product_id: VALID_UUID,
          floor_percentage: '35.00',
          alert_threshold_percentage: '45.00',
          enabled: true,
          updated_at: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: 35, alert_threshold_percentage: 45, enabled: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.productId).toBe(VALID_UUID);
    expect(body.floor_percentage).toBe(35);
    expect(body.alert_threshold_percentage).toBe(45);
    expect(body.enabled).toBe(true);
    expect(body.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts floor_percentage and alert_threshold_percentage of 0 and 100 (boundary values)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          product_id: VALID_UUID,
          floor_percentage: '0.00',
          alert_threshold_percentage: '100.00',
          enabled: false,
          updated_at: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: 0, alert_threshold_percentage: 100, enabled: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.floor_percentage).toBe(0);
    expect(body.alert_threshold_percentage).toBe(100);
    expect(body.enabled).toBe(false);
  });

  it('passes operator_id as created_by in the DB query', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          product_id: VALID_UUID,
          floor_percentage: '30.00',
          alert_threshold_percentage: '40.00',
          enabled: true,
          updated_at: new Date(),
        },
      ],
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
      body: { floor_percentage: 30, alert_threshold_percentage: 40, enabled: true },
    });

    const queryParams: unknown[] = mockPoolQuery.mock.calls[0]![1] as unknown[];
    expect(queryParams).toContain('test-operator-id');
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET /api/v1/pricing/margin-config/:productId', () => {
  it('returns 400 when productId is not a valid UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/margin-config/bad-id',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when no margin config exists for product', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with current margin config', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          product_id: VALID_UUID,
          floor_percentage: '25.50',
          alert_threshold_percentage: '35.00',
          enabled: true,
          updated_at: new Date('2026-03-15T12:00:00Z'),
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/pricing/margin-config/${VALID_UUID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.productId).toBe(VALID_UUID);
    expect(body.floor_percentage).toBe(25.5);
    expect(body.alert_threshold_percentage).toBe(35);
    expect(body.enabled).toBe(true);
    expect(body.updatedAt).toBe('2026-03-15T12:00:00.000Z');
  });
});
