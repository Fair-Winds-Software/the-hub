// Authorized by HUB-1674 (E-FE-7 S1) — systemHealth route tests. Mocks
// the pg pool + adminSettings.getSetting + queue getters and drives
// Fastify.inject() to lock the response shapes + RBAC guards.
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockGetSetting = vi.hoisted(() => vi.fn());
const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockGetAllQueueDefinitions = vi.hoisted(() =>
  vi.fn(() => [
    { name: 'queue:stripe-event', concurrency: 5 },
    { name: 'queue:dlq', concurrency: 0 },
  ]),
);
const mockGetJobCounts = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ waiting: 3, active: 1, delayed: 0, failed: 2 }),
);
const mockGetJobs = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue([
      { timestamp: Date.now() - 45_000 },
    ]),
);
const mockGetStripeEventQueue = vi.hoisted(() =>
  vi.fn(() => ({ getJobCounts: mockGetJobCounts, getJobs: mockGetJobs })),
);
const mockGetDlqQueue = vi.hoisted(() =>
  vi.fn(() => ({ getJobCounts: mockGetJobCounts, getJobs: mockGetJobs })),
);

vi.mock('../../../services/adminSettings.js', () => ({
  getSetting: mockGetSetting,
}));
vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));
vi.mock('../../../queues/index.js', () => ({
  getAllQueueDefinitions: mockGetAllQueueDefinitions,
  getStripeEventQueue: mockGetStripeEventQueue,
  getBatchSweepQueue: vi.fn(),
  getLicenseCheckQueue: vi.fn(),
  getDlqQueue: mockGetDlqQueue,
}));

import adminSystemHealthRoutes, {
  _resetPortfolioCache,
} from '../systemHealth.js';
import { AppError } from '../../../errors/AppError.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PRODUCT_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function build(
  role: 'super_admin' | 'product_admin' = 'super_admin',
  tenantId: string | null = null,
) {
  const instance = Fastify();
  instance.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { operatorUser: unknown }).operatorUser = {
      operator_id: 'op-1',
      role,
      tenant_id: tenantId,
    };
    done();
  });
  instance.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    return reply.status(500).send({ error: 'internal' });
  });
  return instance;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = build();
  await app.register(adminSystemHealthRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetPortfolioCache();
  mockGetSetting.mockResolvedValue(0.05);
  mockGetJobCounts.mockResolvedValue({
    waiting: 3,
    active: 1,
    delayed: 0,
    failed: 2,
  });
  mockGetJobs.mockResolvedValue([{ timestamp: Date.now() - 45_000 }]);
});

describe('GET /api/v1/admin/system-health/portfolio (HUB-1674)', () => {
  it('returns per-product rows + meta.threshold from settings', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM products p')) {
        return Promise.resolve({
          rows: [
            {
              product_id: PRODUCT_A,
              active: true,
              health_check_url: null,
              last_probe_at: null,
              last_probe_reachable: null,
              last_probe_error: null,
              last_probe_latency_ms: null,
            },
            {
              product_id: PRODUCT_B,
              active: false,
              health_check_url: null,
              last_probe_at: null,
              last_probe_reachable: null,
              last_probe_error: null,
              last_probe_latency_ms: null,
            },
          ],
        });
      }
      if (sql.includes('FROM audit_log')) {
        return Promise.resolve({
          rows: [
            {
              product_id: PRODUCT_A,
              total_count: '10',
              failure_count: '3',
              last_failure_at: new Date('2026-06-30T00:00:00.000Z'),
              last_failure_new_values: { message: 'stripe webhook failed' },
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/portfolio',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      meta: { threshold: 0.05 },
    });
    expect(body.products).toHaveLength(2);
    const rowA = body.products.find(
      (p: { productId: string }) => p.productId === PRODUCT_A,
    );
    expect(rowA).toMatchObject({
      reachable: true,
      errorRate24h: 0.3,
      lastErrorEvent: { message: 'stripe webhook failed' },
    });
    const rowB = body.products.find(
      (p: { productId: string }) => p.productId === PRODUCT_B,
    );
    expect(rowB).toMatchObject({ reachable: false, errorRate24h: 0 });
  });

  it('cache: second call within 30s reuses the payload without a DB query', async () => {
    mockPoolQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/portfolio',
    });
    expect(first.statusCode).toBe(200);
    const firstDbCalls = mockPoolQuery.mock.calls.length;
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/portfolio',
    });
    expect(second.statusCode).toBe(200);
    expect(mockPoolQuery.mock.calls.length).toBe(firstDbCalls);
  });

  it('?fresh=true bypasses the 30s cache + recomputes from the DB', async () => {
    mockPoolQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/portfolio',
    });
    expect(first.statusCode).toBe(200);
    const firstDbCalls = mockPoolQuery.mock.calls.length;
    // Second call WITH ?fresh=true must hit the DB again.
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/portfolio?fresh=true',
    });
    expect(second.statusCode).toBe(200);
    expect(mockPoolQuery.mock.calls.length).toBeGreaterThan(firstDbCalls);
  });

  it('product_admin gets a tenant-scoped portfolio call', async () => {
    const scoped = build('product_admin', TENANT_A);
    await scoped.register(adminSystemHealthRoutes);
    await scoped.ready();
    mockPoolQuery.mockImplementation((sql: string, values: unknown[]) => {
      if (sql.includes('FROM products p')) {
        expect(sql).toContain('WHERE p.tenant_id');
        expect(values[0]).toBe(TENANT_A);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await scoped.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/portfolio',
    });
    expect(res.statusCode).toBe(200);
    await scoped.close();
  });
});

describe('GET /api/v1/admin/system-health/queues (HUB-1674)', () => {
  it('returns one row per queue definition with depth + DLQ + oldest-age', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/queues',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queues).toHaveLength(2);
    const stripe = body.queues.find(
      (q: { name: string }) => q.name === 'queue:stripe-event',
    );
    // waiting(3) + active(1) + delayed(0) = 4; dlq = failed(2)
    expect(stripe.depth).toBe(4);
    expect(stripe.dlqSize).toBe(2);
    expect(stripe.oldestJobAgeSeconds).toBeGreaterThan(0);
  });

  it('product_admin is 403', async () => {
    const scoped = build('product_admin', TENANT_A);
    await scoped.register(adminSystemHealthRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/queues',
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });
});

describe('GET /api/v1/admin/system-health/stripe-webhooks (HUB-1674)', () => {
  it('returns aggregate + successRate over the windowHours param', async () => {
    mockPoolQuery.mockImplementation(() =>
      Promise.resolve({
        rows: [
          {
            success_count: '96',
            failure_count: '4',
            pending_retry_count: '0',
            last_failed_at: new Date('2026-06-30T00:00:00.000Z'),
          },
        ],
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/stripe-webhooks?windowHours=48',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.successCount).toBe(96);
    expect(body.failureCount).toBe(4);
    expect(body.successRate).toBeCloseTo(0.96);
  });

  it('product_admin is 403', async () => {
    const scoped = build('product_admin', TENANT_A);
    await scoped.register(adminSystemHealthRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/stripe-webhooks',
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });
});

describe('GET /api/v1/admin/system-health/audit-errors (HUB-1674)', () => {
  it('super_admin can pass an arbitrary productId', async () => {
    mockPoolQuery.mockImplementation(() =>
      Promise.resolve({
        rows: [
          {
            id: 'evt-1',
            tenant_id: TENANT_A,
            product_id: PRODUCT_A,
            actor_id: 'op-1',
            event_type: 'auth.login.failure',
            severity: 'error',
            new_values: { message: 'invalid password' },
            occurred_at: new Date('2026-06-30T00:00:00.000Z'),
          },
        ],
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/system-health/audit-errors?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({
      eventType: 'auth.login.failure',
      message: 'invalid password',
    });
  });

  it('product_admin querying an out-of-scope productId → 403', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM products')) {
        // No row means the product is not owned by this tenant.
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const scoped = build('product_admin', TENANT_A);
    await scoped.register(adminSystemHealthRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'GET',
      url: `/api/v1/admin/system-health/audit-errors?productId=${PRODUCT_B}`,
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });

  it('product_admin without a productId gets their tenant scoped rows', async () => {
    let capturedSql = '';
    let capturedValues: unknown[] = [];
    mockPoolQuery.mockImplementation((sql: string, values: unknown[]) => {
      if (sql.includes('FROM audit_log')) {
        capturedSql = sql;
        capturedValues = values;
      }
      return Promise.resolve({ rows: [] });
    });
    const scoped = build('product_admin', TENANT_A);
    await scoped.register(adminSystemHealthRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'GET',
      url: '/api/v1/admin/system-health/audit-errors',
    });
    expect(res.statusCode).toBe(200);
    expect(capturedSql).toContain('tenant_id =');
    expect(capturedValues).toContain(TENANT_A);
    await scoped.close();
  });
});
