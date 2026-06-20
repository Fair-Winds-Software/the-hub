// Authorized by HUB-725 — unit tests: acknowledge, resolve, paginated list; operator JWT
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ── Mock setup ────────────────────────────────────────────────────────────────

const _mockClientQuery = vi.hoisted(() => vi.fn());
const mockClientRelease = vi.hoisted(() => vi.fn());
const mockPoolConnect = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ connect: mockPoolConnect, query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import alertRoutes from '../alertRoutes.js';

const TENANT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ALERT_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';

const ALERT_ROW = {
  id: ALERT_ID,
  tenant_id: TENANT_ID,
  product_id: 'cccccccc-0000-0000-0000-000000000003',
  alert_type: 'below_floor',
  severity: 'warning',
  payload: { marginPercentage: 10 },
  status: 'new',
  fire_count: 1,
  first_fired_at: new Date('2026-06-01T00:00:00Z'),
  last_fired_at: new Date('2026-06-01T00:00:00Z'),
  acknowledged_at: null,
  resolved_at: null,
};

async function buildTestApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  (fastify as any).decorate('authenticateOperator', async (request: any) => {
    request.operator_id = 'test-operator-id';
  });
  await fastify.register(alertRoutes);
  await fastify.ready();
  return fastify;
}

// Transaction-control statements (BEGIN/COMMIT/ROLLBACK) are passed through with empty rows so the
// `queries` array only mocks real data queries — keeps individual tests readable.
function setupClientMock(queries: Array<{ rows: unknown[] }>) {
  let callIndex = 0;
  mockPoolConnect.mockResolvedValueOnce({
    query: vi.fn().mockImplementation((sql: string) => {
      const trimmed = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve(queries[callIndex++]);
    }),
    release: mockClientRelease,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── POST acknowledge ──────────────────────────────────────────────────────────

describe('POST /api/v1/alerts/:tenantId/:alertId/acknowledge', () => {
  it('returns 200 with updated alert for new → acknowledged transition', async () => {
    setupClientMock([
      { rows: [{ id: ALERT_ID, status: 'new' }] },
      { rows: [{ ...ALERT_ROW, status: 'acknowledged', acknowledged_at: new Date() }] },
    ]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/${ALERT_ID}/acknowledge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'acknowledged' });
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when alert is already acknowledged', async () => {
    setupClientMock([{ rows: [{ id: ALERT_ID, status: 'acknowledged' }] }]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/${ALERT_ID}/acknowledge`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('already acknowledged');
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when alert is resolved', async () => {
    setupClientMock([{ rows: [{ id: ALERT_ID, status: 'resolved' }] }]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/${ALERT_ID}/acknowledge`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Cannot acknowledge a resolved alert');
    } finally {
      await fastify.close();
    }
  });

  it('returns 404 when alert not found or belongs to different tenant', async () => {
    setupClientMock([{ rows: [] }]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/${ALERT_ID}/acknowledge`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for non-UUID alertId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/not-a-uuid/acknowledge`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/bad-id/${ALERT_ID}/acknowledge`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });
});

// ── POST resolve ──────────────────────────────────────────────────────────────

describe('POST /api/v1/alerts/:tenantId/:alertId/resolve', () => {
  it('returns 200 with updated alert for new → resolved transition', async () => {
    setupClientMock([
      { rows: [{ id: ALERT_ID, status: 'new' }] },
      { rows: [{ ...ALERT_ROW, status: 'resolved', resolved_at: new Date() }] },
    ]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/${ALERT_ID}/resolve`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'resolved' });
    } finally {
      await fastify.close();
    }
  });

  it('returns 200 for acknowledged → resolved transition', async () => {
    setupClientMock([
      { rows: [{ id: ALERT_ID, status: 'acknowledged' }] },
      { rows: [{ ...ALERT_ROW, status: 'resolved', resolved_at: new Date() }] },
    ]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/${ALERT_ID}/resolve`,
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when alert is already resolved', async () => {
    setupClientMock([{ rows: [{ id: ALERT_ID, status: 'resolved' }] }]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/${ALERT_ID}/resolve`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('already resolved');
    } finally {
      await fastify.close();
    }
  });

  it('returns 404 when alert not found', async () => {
    setupClientMock([{ rows: [] }]);
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/alerts/${TENANT_ID}/${ALERT_ID}/resolve`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });
});

// ── GET /api/v1/alerts/:tenantId ─────────────────────────────────────────────

describe('GET /api/v1/alerts/:tenantId', () => {
  it('returns 200 with alerts array and total', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [ALERT_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/${TENANT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ alerts: unknown[]; total: number; limit: number; offset: number }>();
      expect(body.alerts).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
    } finally {
      await fastify.close();
    }
  });

  it('returns empty alerts array when none match', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/${TENANT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ alerts: unknown[] }>().alerts).toHaveLength(0);
    } finally {
      await fastify.close();
    }
  });

  it('appends status filter to query when provided', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/${TENANT_ID}?status=new`,
      });
      const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
      expect(sql).toContain('status = $');
    } finally {
      await fastify.close();
    }
  });

  it('appends severity filter to query when provided', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/${TENANT_ID}?severity=warning`,
      });
      const sql: string = mockPoolQuery.mock.calls[0]![0] as string;
      expect(sql).toContain('severity = $');
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for invalid status query value', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/${TENANT_ID}?status=invalid`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for invalid severity query value', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/${TENANT_ID}?severity=extreme`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/bad-id`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('caps limit at 100 when limit > 100 supplied', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/${TENANT_ID}?limit=999`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ limit: number }>().limit).toBe(100);
    } finally {
      await fastify.close();
    }
  });

  it('passes offset to query', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/alerts/${TENANT_ID}?offset=10`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ offset: number }>().offset).toBe(10);
    } finally {
      await fastify.close();
    }
  });
});
