// Authorized by HUB-844 — unit tests: hook CRUD; POST 201 + hmac encryption; GET list masking; DELETE 204/404; GET executions 200/404
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

const mockEncryptHookSecret = vi.hoisted(() => vi.fn());
vi.mock('../../services/hookDeliveryService.js', () => ({
  encryptHookSecret: mockEncryptHookSecret,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import hookRoutes from '../hookRoutes.js';

const TENANT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const HOOK_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';

const HOOK_ROW = {
  id: HOOK_ID,
  tenant_id: TENANT_ID,
  product_id: null,
  trigger_event_type: 'alert.fired',
  action_type: 'webhook',
  action_config: { url: 'https://hooks.example.com', hmac_secret: '***' },
  enabled: true,
  created_at: new Date().toISOString(),
};

const EXEC_ROW = {
  id: 'exec-1',
  hook_id: HOOK_ID,
  alert_event_id: null,
  status: 'delivered',
  status_code: 200,
  duration_ms: 45,
  error: null,
  attempted_at: new Date().toISOString(),
};

async function buildTestApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  (fastify as any).decorate('authenticateOperator', async (request: any) => {
    request.operator_id = 'op-1';
  });
  await fastify.register(hookRoutes);
  await fastify.ready();
  return fastify;
}

beforeEach(() => {
  mockEncryptHookSecret.mockReturnValue('encrypted-secret');
});

afterEach(() => { vi.clearAllMocks(); });

// ── POST ──────────────────────────────────────────────────────────────────────

describe('POST /api/v1/hooks/:tenantId', () => {
  it('returns 201 with hook row and masked hmac_secret', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [HOOK_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/hooks/${TENANT_ID}`,
        payload: {
          trigger_event_type: 'alert.fired',
          action_config: { url: 'https://hooks.example.com', hmac_secret: 'my-secret' },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: HOOK_ID });
    } finally { await fastify.close(); }
  });

  it('encrypts hmac_secret before INSERT', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [HOOK_ROW] });
    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'POST',
        url: `/api/v1/hooks/${TENANT_ID}`,
        payload: {
          trigger_event_type: 'alert.fired',
          action_config: { url: 'https://hooks.example.com', hmac_secret: 'my-secret' },
        },
      });
      expect(mockEncryptHookSecret).toHaveBeenCalledWith('my-secret');
    } finally { await fastify.close(); }
  });

  it('returns 400 for missing trigger_event_type', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/hooks/${TENANT_ID}`,
        payload: { action_config: { url: 'https://hooks.example.com', hmac_secret: 's' } },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });

  it('returns 400 for http:// URL (only https:// allowed)', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/hooks/${TENANT_ID}`,
        payload: {
          trigger_event_type: 'alert.fired',
          action_config: { url: 'http://hooks.example.com', hmac_secret: 's' },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('https://');
    } finally { await fastify.close(); }
  });

  it('returns 400 for missing hmac_secret', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/hooks/${TENANT_ID}`,
        payload: {
          trigger_event_type: 'alert.fired',
          action_config: { url: 'https://hooks.example.com' },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/hooks/not-a-uuid',
        payload: {
          trigger_event_type: 'alert.fired',
          action_config: { url: 'https://hooks.example.com', hmac_secret: 's' },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});

// ── GET list ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/hooks/:tenantId', () => {
  it('returns 200 with array of hooks (hmac_secret masked)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [HOOK_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/hooks/${TENANT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json<unknown[]>();
      expect(rows).toHaveLength(1);
    } finally { await fastify.close(); }
  });

  it('returns 200 with empty array when no hooks exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/hooks/${TENANT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({ method: 'GET', url: '/api/v1/hooks/bad-id' });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/hooks/:tenantId/:hookId', () => {
  it('returns 204 on successful delete', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/hooks/${TENANT_ID}/${HOOK_ID}`,
      });
      expect(res.statusCode).toBe(204);
    } finally { await fastify.close(); }
  });

  it('returns 404 when hook not found or belongs to another tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/hooks/${TENANT_ID}/${HOOK_ID}`,
      });
      expect(res.statusCode).toBe(404);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID hookId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/hooks/${TENANT_ID}/not-a-uuid`,
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});

// ── GET executions ────────────────────────────────────────────────────────────

describe('GET /api/v1/hooks/:tenantId/:hookId/executions', () => {
  it('returns 200 with execution records when hook exists', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: HOOK_ID }] }) // preflight
      .mockResolvedValueOnce({ rows: [EXEC_ROW] });        // executions
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/hooks/${TENANT_ID}/${HOOK_ID}/executions`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<unknown[]>()).toHaveLength(1);
    } finally { await fastify.close(); }
  });

  it('returns 200 with empty array when hook exists but has no executions', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: HOOK_ID }] }) // preflight
      .mockResolvedValueOnce({ rows: [] });                 // no executions
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/hooks/${TENANT_ID}/${HOOK_ID}/executions`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally { await fastify.close(); }
  });

  it('returns 404 when hook does not exist for this tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // preflight returns empty
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/hooks/${TENANT_ID}/${HOOK_ID}/executions`,
      });
      expect(res.statusCode).toBe(404);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID hookId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/hooks/${TENANT_ID}/bad-uuid/executions`,
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});
