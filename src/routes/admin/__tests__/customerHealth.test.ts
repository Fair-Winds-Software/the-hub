// Authorized by HUB-1680 (E-FE-9 S1) — customerHealth route tests. Mocks
// pool + settings + planAdvisor + wraps Fastify.inject() to lock the
// response shapes + RBAC guards + cache bypass + badge derivation.
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
const mockGetLatestRecommendation = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
);
const mockGetBillingSummary = vi.hoisted(() =>
  vi.fn().mockResolvedValue([]),
);

vi.mock('../../../services/adminSettings.js', () => ({
  getSetting: mockGetSetting,
}));
vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));
vi.mock('../../../services/planAdvisorService.js', () => ({
  getLatestRecommendation: mockGetLatestRecommendation,
  getBillingSummary: mockGetBillingSummary,
}));

import adminCustomerHealthRoutes, {
  _resetCustomerHealthCache,
} from '../customerHealth.js';
import { AppError } from '../../../errors/AppError.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
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
  await app.register(adminCustomerHealthRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function defaultQueryImpl(sql: string): Promise<{ rows: unknown[] }> {
  if (sql.includes('FROM tenants t')) {
    return Promise.resolve({
      rows: [
        {
          tenant_id: TENANT_A,
          tenant_name: 'Acme',
          product_id: PRODUCT_A,
          product_name: 'Synapz',
        },
        {
          tenant_id: TENANT_B,
          tenant_name: 'Beta Corp',
          product_id: PRODUCT_B,
          product_name: 'ContentHelm',
        },
      ],
    });
  }
  if (sql.includes('FROM usage_events')) {
    // Default: healthy usage — 100 events last 30d, 100 prior 30d, active
    // yesterday. No stale_no_activity, no declining_usage_30d.
    return Promise.resolve({
      rows: [
        {
          last_active_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
          events_last_30d: '100',
          events_prior_30d: '100',
        },
      ],
    });
  }
  if (sql.includes('FROM invoices')) {
    return Promise.resolve({ rows: [{ has_recent: false }] });
  }
  if (sql.includes('FROM plan_change_ledger') && sql.includes('EXISTS')) {
    return Promise.resolve({ rows: [{ has_recent: false }] });
  }
  if (sql.includes('FROM plan_change_ledger')) {
    return Promise.resolve({ rows: [{ plan_id: 'starter' }] });
  }
  return Promise.resolve({ rows: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCustomerHealthCache();
  mockGetSetting.mockImplementation((key: string) => {
    if (key === 'customer_health_red_threshold') return Promise.resolve(0.7);
    if (key === 'customer_health_yellow_threshold') return Promise.resolve(0.4);
    if (key === 'customer_health_stale_days') return Promise.resolve(14);
    return Promise.resolve(null);
  });
  mockGetLatestRecommendation.mockResolvedValue(null);
  mockGetBillingSummary.mockResolvedValue([
    { total_cost_cents: 15000, period_start: '2026-06-01T00:00:00.000Z' },
  ]);
  mockPoolQuery.mockImplementation(defaultQueryImpl);
});

describe('GET /api/v1/admin/customer-health (HUB-1680)', () => {
  it('returns healthy rows + meta.thresholds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customer-health',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toEqual({
      thresholds: { red: 0.7, yellow: 0.4, staleDays: 14 },
    });
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    // Default sort = risk DESC; both are 0-score healthy → tenant name tiebreak.
    expect(body.rows[0].tenantName).toBe('Acme');
    expect(body.rows[0].healthBadge).toBe('green');
    expect(body.rows[0].churnRiskScore).toBe(0);
    expect(body.rows[0].mrrCents).toBe(15000);
    expect(body.rows[0].planKey).toBe('starter');
  });

  it('cache: second call within 5min reuses payload without re-computing', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customer-health',
    });
    expect(first.statusCode).toBe(200);
    const firstQueryCalls = mockPoolQuery.mock.calls.length;
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customer-health',
    });
    expect(second.statusCode).toBe(200);
    expect(mockPoolQuery.mock.calls.length).toBe(firstQueryCalls);
  });

  it('?fresh=true bypasses the 5-min cache', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customer-health',
    });
    expect(first.statusCode).toBe(200);
    const firstQueryCalls = mockPoolQuery.mock.calls.length;
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customer-health?fresh=true',
    });
    expect(second.statusCode).toBe(200);
    expect(mockPoolQuery.mock.calls.length).toBeGreaterThan(firstQueryCalls);
  });

  it('badge=red when payment failure + stale-no-activity trigger', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM tenants t')) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: TENANT_A,
              tenant_name: 'Acme',
              product_id: PRODUCT_A,
              product_name: 'Synapz',
            },
          ],
        });
      }
      if (sql.includes('FROM usage_events')) {
        return Promise.resolve({
          rows: [
            {
              last_active_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
              events_last_30d: '0',
              events_prior_30d: '50',
            },
          ],
        });
      }
      if (sql.includes('FROM invoices')) {
        return Promise.resolve({ rows: [{ has_recent: true }] });
      }
      if (sql.includes('FROM plan_change_ledger') && sql.includes('EXISTS')) {
        return Promise.resolve({ rows: [{ has_recent: false }] });
      }
      if (sql.includes('FROM plan_change_ledger')) {
        return Promise.resolve({ rows: [{ plan_id: 'starter' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customer-health',
    });
    const body = res.json();
    expect(body.rows[0].healthBadge).toBe('red');
    // stale (0.3) + payment_failure (0.3) + declining_usage (0.25) = 0.85, capped at 1
    expect(body.rows[0].churnRiskScore).toBeGreaterThanOrEqual(0.7);
    expect(body.rows[0].signals).toEqual(
      expect.arrayContaining([
        'stale_no_activity',
        'payment_failure_recent',
        'declining_usage_30d',
      ]),
    );
  });

  it('product_admin only sees their own tenant', async () => {
    const scoped = build('product_admin', TENANT_A);
    await scoped.register(adminCustomerHealthRoutes);
    await scoped.ready();
    _resetCustomerHealthCache();
    let capturedParams: unknown[] = [];
    mockPoolQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM tenants t')) {
        capturedParams = params;
        return Promise.resolve({
          rows: [
            {
              tenant_id: TENANT_A,
              tenant_name: 'Acme',
              product_id: PRODUCT_A,
              product_name: 'Synapz',
            },
          ],
        });
      }
      return defaultQueryImpl(sql);
    });
    const res = await scoped.inject({
      method: 'GET',
      url: '/api/v1/admin/customer-health',
    });
    expect(res.statusCode).toBe(200);
    expect(capturedParams).toContain(TENANT_A);
    await scoped.close();
  });

  it('riskLevel=high filters to red-only rows', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM tenants t')) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: TENANT_A,
              tenant_name: 'Acme',
              product_id: PRODUCT_A,
              product_name: 'Synapz',
            },
            {
              tenant_id: TENANT_B,
              tenant_name: 'Beta Corp',
              product_id: PRODUCT_B,
              product_name: 'ContentHelm',
            },
          ],
        });
      }
      if (sql.includes('FROM usage_events')) {
        // Distinguish per-tenant by looking at params — but simpler: alternate
        // stale vs healthy on successive calls.
        const call = mockPoolQuery.mock.calls.filter((c: unknown[]) =>
          (c[0] as string).includes('FROM usage_events'),
        ).length;
        if (call === 1) {
          return Promise.resolve({
            rows: [
              {
                last_active_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
                events_last_30d: '0',
                events_prior_30d: '0',
              },
            ],
          });
        }
        return Promise.resolve({
          rows: [
            {
              last_active_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
              events_last_30d: '100',
              events_prior_30d: '100',
            },
          ],
        });
      }
      if (sql.includes('FROM invoices'))
        return Promise.resolve({ rows: [{ has_recent: false }] });
      if (sql.includes('FROM plan_change_ledger') && sql.includes('EXISTS'))
        return Promise.resolve({ rows: [{ has_recent: false }] });
      if (sql.includes('FROM plan_change_ledger'))
        return Promise.resolve({ rows: [{ plan_id: 'starter' }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/customer-health?riskLevel=high',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Acme (stale 60d) → red; Beta Corp (healthy) → green. High-filter keeps Acme only.
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].tenantName).toBe('Acme');
    expect(body.rows[0].healthBadge).toBe('red');
  });
});

describe('GET /api/v1/admin/customer-health/:tenantId (HUB-1680)', () => {
  it('super_admin gets the drill-in bundle with a 90d usage timeline', async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM tenants t\n           JOIN products')) {
        return Promise.resolve({
          rows: [{ tenant_name: 'Acme', product_name: 'Synapz' }],
        });
      }
      if (sql.includes('FROM usage_events') && sql.includes('DATE_TRUNC')) {
        return Promise.resolve({
          rows: [
            { day: yesterday, event_count: '10' },
            { day: today, event_count: '20' },
          ],
        });
      }
      if (sql.includes('FROM usage_events')) {
        return Promise.resolve({
          rows: [
            {
              last_active_at: today,
              events_last_30d: '100',
              events_prior_30d: '100',
            },
          ],
        });
      }
      if (sql.includes('FROM invoices'))
        return Promise.resolve({ rows: [{ has_recent: false }] });
      if (sql.includes('FROM plan_change_ledger') && sql.includes('EXISTS'))
        return Promise.resolve({ rows: [{ has_recent: false }] });
      if (sql.includes('FROM plan_change_ledger'))
        return Promise.resolve({ rows: [{ plan_id: 'growth' }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/customer-health/${TENANT_A}?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant).toEqual({ id: TENANT_A, name: 'Acme' });
    expect(body.product).toEqual({ id: PRODUCT_A, name: 'Synapz' });
    expect(body.currentPlan).toEqual({ key: 'growth' });
    expect(body.mrr).toEqual({ cents: 15000, currency: 'USD' });
    expect(body.healthBadge).toBe('green');
    expect(body.usageTimeline90d).toHaveLength(2);
    expect(body.meta.thresholds).toEqual({ red: 0.7, yellow: 0.4, staleDays: 14 });
  });

  it('returns 400 when productId query is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/customer-health/${TENANT_A}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the tenant + product pair does not exist', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM tenants t\n           JOIN products')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/customer-health/${TENANT_A}?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('product_admin querying another tenant → 403', async () => {
    const scoped = build('product_admin', TENANT_B);
    await scoped.register(adminCustomerHealthRoutes);
    await scoped.ready();
    _resetCustomerHealthCache();
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM tenants t\n           JOIN products')) {
        return Promise.resolve({
          rows: [{ tenant_name: 'Acme', product_name: 'Synapz' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await scoped.inject({
      method: 'GET',
      url: `/api/v1/admin/customer-health/${TENANT_A}?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });
});
