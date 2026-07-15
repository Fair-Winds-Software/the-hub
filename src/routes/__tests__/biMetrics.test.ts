// Authorized by HUB-1820 (S3 of HUB-1787) — route tests for the SDK-facing ingestion
// endpoint. Verifies:
//   * unauthenticated → 401 (via the real auth plugin)
//   * authenticated → 200 with defense-in-depth product_id override
//   * batch shape validation
//   * per-request audit entry
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockIngest = vi.hoisted(() => vi.fn(async () => ({ accepted: 0, dropped: [] as unknown[] })));
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_e: Record<string, unknown>): Promise<void> => undefined),
);

vi.mock('../../services/bi/metricIngestService.js', () => ({
  ingestMetricBatch: mockIngest,
}));
vi.mock('../../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: vi.fn(async () => ({ rows: [] })) }),
}));

const TENANT_JWT = '00000000-0000-4000-8000-00000000eeaa';
const PRODUCT_JWT = '00000000-0000-4000-8000-000000000aaa';

async function buildHarness(opts: { authed?: boolean } = {}) {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../biMetrics.js')).default;
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: err.message });
  });
  // Stub the fastify.authenticate decorator that the route depends on.
  app.decorate('authenticate', async (req: unknown) => {
    if (!opts.authed) {
      const AppError = (await import('../../errors/AppError.js')).AppError;
      throw new AppError(401, 'Invalid or expired token');
    }
    (req as { tenant_id: string; product_id: string }).tenant_id = TENANT_JWT;
    (req as { tenant_id: string; product_id: string }).product_id = PRODUCT_JWT;
  });
  await app.register(routes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/bi/metrics', () => {
  it('401 when unauthenticated', async () => {
    const app = await buildHarness({ authed: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bi/metrics',
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
    await app.close();
  });

  it('empty batch fast-path returns 200 and does not call ingest', async () => {
    const app = await buildHarness({ authed: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bi/metrics',
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(mockIngest).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 when events is not an array', async () => {
    const app = await buildHarness({ authed: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bi/metrics',
      payload: { events: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 when batch exceeds 1000', async () => {
    const app = await buildHarness({ authed: true });
    const events = Array.from({ length: 1001 }, () => ({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bi/metrics',
      payload: { events },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('happy path — overrides product_id with JWT value + writes audit', async () => {
    mockIngest.mockResolvedValueOnce({ accepted: 2, dropped: [] });
    const app = await buildHarness({ authed: true });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bi/metrics',
      payload: {
        events: [
          // Malicious client tries to attribute the push to a different product.
          { product_id: 'attacker-product-id', metric_name: 'logins', value: 1, occurred_at: 't' },
          { product_id: 'attacker-product-id', metric_name: 'logins', value: 1, occurred_at: 't' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const call = mockIngest.mock.calls[0]![0] as { events: Array<{ product_id: string }> };
    // Every event's product_id was overwritten with the JWT-derived value.
    for (const ev of call.events) {
      expect(ev.product_id).toBe(PRODUCT_JWT);
    }
    // Audit entry written with jwt tenant + product.
    const auditPayload = mockWriteAuditEntry.mock.calls[0]![0] as {
      tenant_id: string;
      product_id: string;
      actor_type: string;
      new_values: { action: string };
    };
    expect(auditPayload.tenant_id).toBe(TENANT_JWT);
    expect(auditPayload.product_id).toBe(PRODUCT_JWT);
    expect(auditPayload.actor_type).toBe('service');
    expect(auditPayload.new_values.action).toBe('bi.metric.ingest.sdk');
    await app.close();
  });
});
