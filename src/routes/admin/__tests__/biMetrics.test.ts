// Authorized by HUB-1805 (S3 of HUB-1785) — route tests for POST /api/v1/admin/bi/metrics.
// Ingestion service is mocked so the route wiring is exercised without touching PG.
// Covers: RBAC (super_admin OR service token), request validation, batch-summary audit,
// per-unknown-metric audit.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockIngest = vi.hoisted(() =>
  vi.fn(async () => ({ accepted: 0, dropped: [] as unknown[] })),
);
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_entry: Record<string, unknown>): Promise<void> => undefined),
);

vi.mock('../../../services/bi/metricIngestService.js', () => ({
  ingestMetricBatch: mockIngest,
}));
vi.mock('../../../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));
vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: vi.fn(async () => ({ rows: [] })) }),
}));

async function buildHarness(role?: 'super_admin' | 'product_admin') {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../biMetrics.js')).default;
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: err.message });
  });
  if (role) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { operator: { role: string; operator_id: string } }).operator = {
        role,
        operator_id: 'op-1',
      };
    });
  }
  await app.register(routes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['HUB_SERVICE_TOKEN'];
});

describe('POST /api/v1/admin/bi/metrics — RBAC', () => {
  it('403 when no operator role and no service token', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('403 when product_admin (super_admin required unless service token)', async () => {
    const app = await buildHarness('product_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('200 when super_admin', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('200 when service token matches HUB_SERVICE_TOKEN', async () => {
    process.env['HUB_SERVICE_TOKEN'] = 'secret-service-token';
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      headers: { 'x-hub-service-token': 'secret-service-token' },
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('403 when service token header is wrong', async () => {
    process.env['HUB_SERVICE_TOKEN'] = 'secret-service-token';
    const app = await buildHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      headers: { 'x-hub-service-token': 'wrong-token' },
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /api/v1/admin/bi/metrics — request validation', () => {
  it('400 when events is not an array', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      payload: { events: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 when batch exceeds 1000 events', async () => {
    const app = await buildHarness('super_admin');
    const events = Array.from({ length: 1001 }, () => ({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      payload: { events },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('empty batch fast-path returns 200 with accepted=0 and does NOT call the service', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { accepted: number; dropped: unknown[] };
    expect(body.accepted).toBe(0);
    expect(body.dropped).toEqual([]);
    expect(mockIngest).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /api/v1/admin/bi/metrics — happy path + audit', () => {
  it('happy path: passes events to service and writes one batch-summary audit entry', async () => {
    mockIngest.mockResolvedValueOnce({ accepted: 3, dropped: [] });
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      payload: {
        events: [
          { product_id: 'p1', metric_name: 'logins', value: 1, occurred_at: 't' },
          { product_id: 'p1', metric_name: 'logins', value: 1, occurred_at: 't' },
          { product_id: 'p1', metric_name: 'logins', value: 1, occurred_at: 't' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { accepted: number; dropped: unknown[] };
    expect(body.accepted).toBe(3);
    expect(mockIngest).toHaveBeenCalledOnce();
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const auditPayload = mockWriteAuditEntry.mock.calls[0]![0] as {
      new_values: { action: string; accepted: number; dropped_count: number };
    };
    expect(auditPayload.new_values.action).toBe('bi.metric.ingest');
    expect(auditPayload.new_values.accepted).toBe(3);
    expect(auditPayload.new_values.dropped_count).toBe(0);
    await app.close();
  });

  it('per-unknown-metric drop writes an additional bi.metric.unknown_metric audit', async () => {
    mockIngest.mockResolvedValueOnce({
      accepted: 0,
      dropped: [
        { index: 0, metric_name: 'not_in_catalog', reason: 'x', category: 'unknown_metric' },
      ],
    });
    const app = await buildHarness('super_admin');
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bi/metrics',
      payload: { events: [{ product_id: 'p1', metric_name: 'not_in_catalog', value: 1, occurred_at: 't' }] },
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(2);
    const secondCall = mockWriteAuditEntry.mock.calls[1]![0] as {
      new_values: { action: string; metric_name: string };
    };
    expect(secondCall.new_values.action).toBe('bi.metric.unknown_metric');
    expect(secondCall.new_values.metric_name).toBe('not_in_catalog');
    await app.close();
  });
});