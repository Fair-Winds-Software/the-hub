// Authorized by HUB-767 — unit tests: GET paginated in-app notifications; PATCH mark-read; operator JWT
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import inAppNotificationRoutes from '../inAppNotificationRoutes.js';

const TENANT_ID       = 'aaaaaaaa-0000-0000-0000-000000000001';
const NOTIFICATION_ID = 'dddddddd-0000-0000-0000-000000000004';

const NOTIF_ROW = {
  id: NOTIFICATION_ID,
  tenant_id: TENANT_ID,
  product_id: 'bbbbbbbb-0000-0000-0000-000000000002',
  alert_event_id: 'cccccccc-0000-0000-0000-000000000003',
  message: '[WARNING] below_floor fired for product prod-1 (fire #1)',
  read: false,
  created_at: new Date().toISOString(),
  total_count: '1',
};

async function buildTestApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  (fastify as any).decorate('authenticateOperator', async (request: any) => {
    request.operator_id = 'op-1';
  });
  await fastify.register(inAppNotificationRoutes);
  await fastify.ready();
  return fastify;
}

afterEach(() => { vi.clearAllMocks(); });

// ── GET list ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/notifications/:tenantId/in-app', () => {
  it('returns 200 with notifications, total, limit, offset', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [NOTIF_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/in-app`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ notifications: unknown[]; total: number; limit: number; offset: number }>();
      expect(body.notifications).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
    } finally { await fastify.close(); }
  });

  it('strips total_count from individual notification objects', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [NOTIF_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/in-app`,
      });
      const body = res.json<{ notifications: Record<string, unknown>[] }>();
      expect(body.notifications[0]).not.toHaveProperty('total_count');
    } finally { await fastify.close(); }
  });

  it('returns empty list and total=0 when no notifications exist', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/in-app`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ notifications: unknown[]; total: number }>();
      expect(body.notifications).toHaveLength(0);
      expect(body.total).toBe(0);
    } finally { await fastify.close(); }
  });

  it('appends read filter when read=true query param provided', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/in-app?read=true`,
      });
      const [sql, params] = mockPoolQuery.mock.calls[0]!;
      expect(sql).toContain('read = $');
      expect(params).toContain(true);
    } finally { await fastify.close(); }
  });

  it('appends read filter when read=false query param provided', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/in-app?read=false`,
      });
      const [sql, params] = mockPoolQuery.mock.calls[0]!;
      expect(sql).toContain('read = $');
      expect(params).toContain(false);
    } finally { await fastify.close(); }
  });

  it('caps limit at 100', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/in-app?limit=999`,
      });
      expect(res.json<{ limit: number }>().limit).toBe(100);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/bad-id/in-app`,
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});

// ── PATCH mark-read ───────────────────────────────────────────────────────────

describe('PATCH /api/v1/notifications/:tenantId/in-app/:notificationId/read', () => {
  it('returns 200 with read=true when notification is unread', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: NOTIFICATION_ID, read: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/notifications/${TENANT_ID}/in-app/${NOTIFICATION_ID}/read`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: NOTIFICATION_ID, read: true });
    } finally { await fastify.close(); }
  });

  it('returns 200 idempotently when notification is already read', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: NOTIFICATION_ID, read: true }] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/notifications/${TENANT_ID}/in-app/${NOTIFICATION_ID}/read`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ read: true });
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    } finally { await fastify.close(); }
  });

  it('returns 404 when notification not found for tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/notifications/${TENANT_ID}/in-app/${NOTIFICATION_ID}/read`,
      });
      expect(res.statusCode).toBe(404);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID notificationId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/notifications/${TENANT_ID}/in-app/not-a-uuid/read`,
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'PATCH',
        url: `/api/v1/notifications/bad-id/in-app/${NOTIFICATION_ID}/read`,
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});
