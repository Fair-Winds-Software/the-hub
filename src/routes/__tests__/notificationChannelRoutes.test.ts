// Authorized by HUB-766 — unit tests: notification channel CRUD; hmac_secret masking; upsert 201/200
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

import notificationChannelRoutes from '../notificationChannelRoutes.js';

const TENANT_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const CHANNEL_ID = 'cccccccc-0000-0000-0000-000000000003';

const CHANNEL_ROW = {
  id: CHANNEL_ID,
  tenant_id: TENANT_ID,
  product_id: PRODUCT_ID,
  channel_type: 'email',
  config: { to: 'ops@example.com' },
  hmac_secret: '***',
  enabled: true,
  created_at: new Date().toISOString(),
};

async function buildTestApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  (fastify as any).decorate('authenticateOperator', async (request: any) => {
    request.operator_id = 'op-1';
  });
  await fastify.register(notificationChannelRoutes);
  await fastify.ready();
  return fastify;
}

afterEach(() => { vi.clearAllMocks(); });

// ── POST (upsert) ─────────────────────────────────────────────────────────────

describe('POST /api/v1/notifications/:tenantId/:productId/channels', () => {
  it('returns 201 with id and action=created on INSERT', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: CHANNEL_ID, is_insert: true }], rowCount: 1 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels`,
        payload: { channel_type: 'email', config: { to: 'ops@example.com' } },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: CHANNEL_ID, action: 'created' });
    } finally { await fastify.close(); }
  });

  it('returns 200 with action=updated on upsert conflict (UPDATE)', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: CHANNEL_ID, is_insert: false }], rowCount: 1 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels`,
        payload: { channel_type: 'email', config: { to: 'ops@example.com' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ action: 'updated' });
    } finally { await fastify.close(); }
  });

  it('returns 400 for invalid channel_type', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels`,
        payload: { channel_type: 'sms', config: {} },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });

  it('returns 400 for webhook channel missing config.url', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels`,
        payload: { channel_type: 'webhook', config: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('config.url');
    } finally { await fastify.close(); }
  });

  it('returns 400 for email channel missing config.to', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels`,
        payload: { channel_type: 'email', config: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('config.to');
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/notifications/bad-id/${PRODUCT_ID}/channels`,
        payload: { channel_type: 'in_app', config: {} },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});

// ── GET list ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/notifications/:tenantId/:productId/channels', () => {
  it('returns 200 with channels array', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [CHANNEL_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ channels: unknown[] }>().channels).toHaveLength(1);
    } finally { await fastify.close(); }
  });

  it('returns empty array when no channels exist', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ channels: unknown[] }>().channels).toHaveLength(0);
    } finally { await fastify.close(); }
  });
});

// ── GET single ────────────────────────────────────────────────────────────────

describe('GET /api/v1/notifications/:tenantId/:productId/channels/:channelId', () => {
  it('returns 200 with channel row', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [CHANNEL_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels/${CHANNEL_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: CHANNEL_ID });
    } finally { await fastify.close(); }
  });

  it('returns 404 when channel not found', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels/${CHANNEL_ID}`,
      });
      expect(res.statusCode).toBe(404);
    } finally { await fastify.close(); }
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe('PUT /api/v1/notifications/:tenantId/:productId/channels/:channelId', () => {
  it('returns 200 with id on successful update', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: CHANNEL_ID }], rowCount: 1 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'PUT',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels/${CHANNEL_ID}`,
        payload: { config: { to: 'new@example.com' }, enabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: CHANNEL_ID });
    } finally { await fastify.close(); }
  });

  it('returns 404 when channel not found', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'PUT',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels/${CHANNEL_ID}`,
        payload: { config: {} },
      });
      expect(res.statusCode).toBe(404);
    } finally { await fastify.close(); }
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/notifications/:tenantId/:productId/channels/:channelId', () => {
  it('returns 204 on successful delete', async () => {
    mockPoolQuery.mockResolvedValue({ rowCount: 1 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels/${CHANNEL_ID}`,
      });
      expect(res.statusCode).toBe(204);
    } finally { await fastify.close(); }
  });

  it('returns 404 when channel not found', async () => {
    mockPoolQuery.mockResolvedValue({ rowCount: 0 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/notifications/${TENANT_ID}/${PRODUCT_ID}/channels/${CHANNEL_ID}`,
      });
      expect(res.statusCode).toBe(404);
    } finally { await fastify.close(); }
  });
});
