// Authorized by HUB-1866 (S1 of HUB-1865) — route tests for
// GET /api/v1/admin/pricing/tenant/:tenantId/entitlement.
//
// Mocks the pg pool so tests exercise route wiring + RBAC + derivation logic
// without touching the DB.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn(async () => ({ rows: [] as unknown[] })));

vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

async function buildHarness(role?: 'super_admin' | 'product_admin') {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../pricingEntitlement.js')).default;
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: err.message });
  });
  if (role) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { operatorUser: { role: string } }).operatorUser = { role };
    });
  }
  await app.register(routes);
  return app;
}

const TENANT = '00000000-0000-4000-8000-000000000eea';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/admin/pricing/tenant/:tenantId/entitlement — RBAC', () => {
  it('403 without an operator role', async () => {
    const app = await buildHarness();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/pricing/tenant/${TENANT}/entitlement`,
    });
    expect(res.statusCode).toBe(403);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    await app.close();
  });

  it('200 for super_admin when tenant exists', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          tenant_exists: true,
          sub_status: 'active',
          plan_id: 'plan-uuid-1',
          current_period_end: '2026-08-15T00:00:00.000Z',
          cancel_at_period_end: false,
        },
      ],
    });
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/pricing/tenant/${TENANT}/entitlement`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('200 for product_admin (both roles can read)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ tenant_exists: true, sub_status: 'active', plan_id: 'p1', current_period_end: null, cancel_at_period_end: false }],
    });
    const app = await buildHarness('product_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/pricing/tenant/${TENANT}/entitlement`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('GET .../entitlement — validation', () => {
  it('400 when tenantId is not a UUID', async () => {
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/pricing/tenant/not-a-uuid/entitlement',
    });
    expect(res.statusCode).toBe(400);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET .../entitlement — derivation', () => {
  async function readBody(role: 'super_admin' | 'product_admin') {
    const app = await buildHarness(role);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/pricing/tenant/${TENANT}/entitlement`,
    });
    const body = JSON.parse(res.body) as {
      tenantId: string;
      planId: string | null;
      subscriptionValid: boolean;
      billingCurrent: boolean;
      entitlements: string[];
      gatingFlags: { reason?: string; expiresAt?: string | null };
      asOf: string;
    };
    await app.close();
    return { statusCode: res.statusCode, body };
  }

  it('404 when the tenant does not exist at all', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = await buildHarness('super_admin');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/pricing/tenant/${TENANT}/entitlement`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('active subscription → subscriptionValid=true + billingCurrent=true, no reason', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          tenant_exists: true,
          sub_status: 'active',
          plan_id: 'plan-active',
          current_period_end: '2026-08-15T00:00:00.000Z',
          cancel_at_period_end: false,
        },
      ],
    });
    const { statusCode, body } = await readBody('super_admin');
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      tenantId: TENANT,
      planId: 'plan-active',
      subscriptionValid: true,
      billingCurrent: true,
      entitlements: [],
    });
    expect(body.gatingFlags.reason).toBeUndefined();
    expect(body.gatingFlags.expiresAt).toBe('2026-08-15T00:00:00.000Z');
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('past_due subscription → subscriptionValid=false + billingCurrent=false, reason=past-due', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          tenant_exists: true,
          sub_status: 'past_due',
          plan_id: 'plan-1',
          current_period_end: '2026-07-01T00:00:00.000Z',
          cancel_at_period_end: false,
        },
      ],
    });
    const { statusCode, body } = await readBody('super_admin');
    expect(statusCode).toBe(200);
    expect(body.subscriptionValid).toBe(false);
    expect(body.billingCurrent).toBe(false);
    expect(body.gatingFlags.reason).toBe('past-due');
  });

  it('canceled subscription → billingCurrent=false, reason=canceled', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          tenant_exists: true,
          sub_status: 'canceled',
          plan_id: 'plan-x',
          current_period_end: null,
          cancel_at_period_end: true,
        },
      ],
    });
    const { statusCode, body } = await readBody('super_admin');
    expect(statusCode).toBe(200);
    expect(body.subscriptionValid).toBe(false);
    expect(body.billingCurrent).toBe(false);
    expect(body.gatingFlags.reason).toBe('canceled');
  });

  it('tenant exists but has no subscription → reason=no-subscription', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          tenant_exists: true,
          sub_status: null,
          plan_id: null,
          current_period_end: null,
          cancel_at_period_end: null,
        },
      ],
    });
    const { statusCode, body } = await readBody('product_admin');
    expect(statusCode).toBe(200);
    expect(body.subscriptionValid).toBe(false);
    expect(body.billingCurrent).toBe(false);
    expect(body.planId).toBeNull();
    expect(body.gatingFlags.reason).toBe('no-subscription');
  });

  it('trialing subscription → subscriptionValid=true (Stripe trial counts as valid)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          tenant_exists: true,
          sub_status: 'trialing',
          plan_id: 'plan-trial',
          current_period_end: '2026-08-01T00:00:00.000Z',
          cancel_at_period_end: false,
        },
      ],
    });
    const { body } = await readBody('super_admin');
    expect(body.subscriptionValid).toBe(true);
    expect(body.billingCurrent).toBe(true);
    expect(body.gatingFlags.reason).toBeUndefined();
  });
});
