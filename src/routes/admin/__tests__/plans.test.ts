// Authorized by HUB-1651 (E-FE-5 S1) — plans CRUD route tests. Mock the
// planCatalogService + auditLogService + db/pool boundary so the route
// handlers can be exercised over Fastify.inject() without a real Postgres.
// Covers happy-path CRUD, RBAC scope, active-subscribers 422 guard, audit
// entry emission, and billing_mode validation.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockCreatePlan = vi.hoisted(() => vi.fn());
const mockGetPlans = vi.hoisted(() => vi.fn());
const mockGetPlanById = vi.hoisted(() => vi.fn());
const mockUpdatePlan = vi.hoisted(() => vi.fn());
const mockUpdatePlanBillingMode = vi.hoisted(() => vi.fn());
const mockSoftArchivePlan = vi.hoisted(() => vi.fn());
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockPoolQuery = vi.hoisted(() => vi.fn());

vi.mock('../../../services/planCatalogService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/planCatalogService.js')
  >('../../../services/planCatalogService.js');
  return {
    ...actual,
    createPlan: mockCreatePlan,
    getPlans: mockGetPlans,
    getPlanById: mockGetPlanById,
    updatePlan: mockUpdatePlan,
    updatePlanBillingMode: mockUpdatePlanBillingMode,
    softArchivePlan: mockSoftArchivePlan,
  };
});

vi.mock('../../../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

import adminPlansRoutes from '../plans.js';
import { AppError } from '../../../errors/AppError.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PLAN_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const BASE_PLAN = {
  id: PLAN_A,
  product_id: PRODUCT_A,
  key: 'starter',
  name: 'Starter',
  description: null,
  billing_type: 'flat_rate',
  billing_interval: 'month',
  unit_amount_cents: 9900,
  tiers: null,
  stripe_product_id: 'sp_1',
  stripe_price_id: 'sr_1',
  entitlements: {},
  active: true,
  metadata: null,
  delta_data: null,
  created_at: new Date(),
  updated_at: new Date(),
};

function build(role: 'super_admin' | 'product_admin' = 'super_admin', tenantId: string | null = null) {
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
  await app.register(adminPlansRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: RBAC pool lookup returns the test product owned by TENANT_A.
  mockPoolQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM products WHERE id')) {
      return Promise.resolve({ rows: [{ tenant_id: TENANT_A }] });
    }
    if (sql.includes('FROM plans pl')) {
      return Promise.resolve({
        rows: [{ product_id: PRODUCT_A, tenant_id: TENANT_A }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
});

describe('GET /api/v1/admin/plans (HUB-1651)', () => {
  it('returns the service list under {data, total}', async () => {
    mockGetPlans.mockResolvedValueOnce([BASE_PLAN]);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/plans?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1 });
    expect(mockGetPlans).toHaveBeenCalledWith(PRODUCT_A, { includeArchived: false });
  });

  it('threads includeArchived=true through to the service', async () => {
    mockGetPlans.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/plans?productId=${PRODUCT_A}&includeArchived=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetPlans).toHaveBeenCalledWith(PRODUCT_A, { includeArchived: true });
  });

  it('404s if the product does not exist', async () => {
    mockPoolQuery.mockImplementationOnce((sql: string) => {
      expect(sql).toContain('FROM products WHERE id');
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/plans?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('403s a product_admin whose tenant does not own the product', async () => {
    const scoped = build('product_admin', TENANT_B);
    await scoped.register(adminPlansRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'GET',
      url: `/api/v1/admin/plans?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });
});

describe('POST /api/v1/admin/plans (HUB-1651)', () => {
  it('creates a plan + writes an INSERT audit entry', async () => {
    mockCreatePlan.mockResolvedValueOnce(BASE_PLAN);
    mockGetPlanById.mockResolvedValueOnce(BASE_PLAN);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/plans',
      payload: {
        productId: PRODUCT_A,
        key: 'starter',
        name: 'Starter',
        billing_type: 'flat_rate',
        billing_interval: 'month',
        unit_amount_cents: 9900,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreatePlan).toHaveBeenCalledWith(PRODUCT_A, expect.objectContaining({
      key: 'starter',
      name: 'Starter',
      billingType: 'flat_rate',
      billingInterval: 'month',
      unitAmountCents: 9900,
    }));
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'INSERT',
        table_name: 'plans',
        record_id: PLAN_A,
      }),
    );
  });

  it('flips billing_mode to credit via updatePlanBillingMode when the body asks for it', async () => {
    mockCreatePlan.mockResolvedValueOnce(BASE_PLAN);
    mockUpdatePlanBillingMode.mockResolvedValueOnce(BASE_PLAN);
    mockGetPlanById.mockResolvedValueOnce(BASE_PLAN);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/plans',
      payload: {
        productId: PRODUCT_A,
        key: 'internal-1',
        name: 'Internal',
        billing_type: 'flat_rate',
        billing_interval: 'month',
        unit_amount_cents: 0,
        billing_mode: 'credit',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockUpdatePlanBillingMode).toHaveBeenCalledWith(
      PLAN_A,
      'credit',
      'op-1',
    );
  });

  it('400s on an invalid billing_type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/plans',
      payload: {
        productId: PRODUCT_A,
        key: 'starter',
        name: 'Starter',
        billing_type: 'bogus',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreatePlan).not.toHaveBeenCalled();
  });

  it('400s on an invalid billing_mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/plans',
      payload: {
        productId: PRODUCT_A,
        key: 'starter',
        name: 'Starter',
        billing_type: 'flat_rate',
        billing_mode: 'bogus',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s when name or key are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/plans',
      payload: {
        productId: PRODUCT_A,
        billing_type: 'flat_rate',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/v1/admin/plans/:planId (HUB-1651)', () => {
  it('routes plain field updates to updatePlan', async () => {
    mockUpdatePlan.mockResolvedValueOnce({ ...BASE_PLAN, name: 'Renamed' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/plans/${PLAN_A}`,
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdatePlan).toHaveBeenCalledWith(
      PLAN_A,
      expect.objectContaining({ name: 'Renamed' }),
      'op-1',
    );
    // billing_mode not touched.
    expect(mockUpdatePlanBillingMode).not.toHaveBeenCalled();
  });

  it('routes billing_mode changes through updatePlanBillingMode', async () => {
    mockUpdatePlan.mockResolvedValueOnce(BASE_PLAN);
    mockUpdatePlanBillingMode.mockResolvedValueOnce(BASE_PLAN);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/plans/${PLAN_A}`,
      payload: { billing_mode: 'credit' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdatePlanBillingMode).toHaveBeenCalledWith(
      PLAN_A,
      'credit',
      'op-1',
    );
  });

  it('400s on an invalid billing_mode', async () => {
    mockUpdatePlan.mockResolvedValueOnce(BASE_PLAN);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/plans/${PLAN_A}`,
      payload: { billing_mode: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/v1/admin/plans/:planId (HUB-1651)', () => {
  it('soft-archives via softArchivePlan and echoes the row', async () => {
    mockSoftArchivePlan.mockResolvedValueOnce({
      ...BASE_PLAN,
      active: false,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/plans/${PLAN_A}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockSoftArchivePlan).toHaveBeenCalledWith(PLAN_A, 'op-1');
  });

  it('returns 422 with {activeSubscribers} when the service throws the guard', async () => {
    const err = new AppError(422, 'Plan has 3 active subscriber(s); archive blocked') as
      AppError & { activeSubscribers: number };
    err.activeSubscribers = 3;
    mockSoftArchivePlan.mockRejectedValueOnce(err);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/plans/${PLAN_A}`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ activeSubscribers: 3 });
  });

  it('403s a product_admin whose tenant does not own the plan', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM plans pl')) {
        return Promise.resolve({
          rows: [{ product_id: PRODUCT_A, tenant_id: TENANT_A }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const scoped = build('product_admin', TENANT_B);
    await scoped.register(adminPlansRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'DELETE',
      url: `/api/v1/admin/plans/${PLAN_A}`,
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });
});
