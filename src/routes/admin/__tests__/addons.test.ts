// Authorized by HUB-1652 (E-FE-5 S2) — add-ons CRUD route tests. Mirrors the
// HUB-1651 plans test harness 1:1: mock addOnService + auditLogService +
// db/pool boundary, then drive Fastify.inject() to exercise every branch.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockCreateAddOn = vi.hoisted(() => vi.fn());
const mockListAddOnsByProduct = vi.hoisted(() => vi.fn());
const mockGetAddOnById = vi.hoisted(() => vi.fn());
const mockUpdateAddOn = vi.hoisted(() => vi.fn());
const mockSoftArchiveAddOn = vi.hoisted(() => vi.fn());
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockPoolQuery = vi.hoisted(() => vi.fn());

vi.mock('../../../services/addOnService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/addOnService.js')
  >('../../../services/addOnService.js');
  return {
    ...actual,
    createAddOn: mockCreateAddOn,
    listAddOnsByProduct: mockListAddOnsByProduct,
    getAddOnById: mockGetAddOnById,
    updateAddOn: mockUpdateAddOn,
    softArchiveAddOn: mockSoftArchiveAddOn,
  };
});

vi.mock('../../../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

import adminAddOnsRoutes from '../addons.js';
import { AppError } from '../../../errors/AppError.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ADDON_A = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const BASE_ADDON = {
  id: ADDON_A,
  product_id: PRODUCT_A,
  key: 'sms-notifications',
  name: 'SMS Notifications',
  description: null,
  billing_type: 'recurring',
  billing_interval: 'month',
  unit_amount_cents: 1900,
  stripe_price_id: 'sr_ao1',
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
      operator_id: 'op-2',
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
  await app.register(adminAddOnsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPoolQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM products WHERE id')) {
      return Promise.resolve({ rows: [{ tenant_id: TENANT_A }] });
    }
    if (sql.includes('FROM add_ons a')) {
      return Promise.resolve({
        rows: [{ product_id: PRODUCT_A, tenant_id: TENANT_A }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
});

describe('GET /api/v1/admin/addons (HUB-1652)', () => {
  it('returns the service list under {data, total}', async () => {
    mockListAddOnsByProduct.mockResolvedValueOnce([BASE_ADDON]);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/addons?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1 });
    expect(mockListAddOnsByProduct).toHaveBeenCalledWith(PRODUCT_A, {
      includeInactive: false,
    });
  });

  it('threads includeArchived=true through as includeInactive to the service', async () => {
    mockListAddOnsByProduct.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/addons?productId=${PRODUCT_A}&includeArchived=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockListAddOnsByProduct).toHaveBeenCalledWith(PRODUCT_A, {
      includeInactive: true,
    });
  });

  it('404s if the product does not exist', async () => {
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [] }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/addons?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('403s a product_admin whose tenant does not own the product', async () => {
    const scoped = build('product_admin', TENANT_B);
    await scoped.register(adminAddOnsRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'GET',
      url: `/api/v1/admin/addons?productId=${PRODUCT_A}`,
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });
});

describe('POST /api/v1/admin/addons (HUB-1652)', () => {
  it('creates an add-on and writes an INSERT audit entry', async () => {
    mockCreateAddOn.mockResolvedValueOnce(BASE_ADDON);
    mockGetAddOnById.mockResolvedValueOnce(BASE_ADDON);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/addons',
      payload: {
        productId: PRODUCT_A,
        key: 'sms-notifications',
        name: 'SMS Notifications',
        billing_type: 'recurring',
        billing_interval: 'month',
        unit_amount_cents: 1900,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreateAddOn).toHaveBeenCalledWith(
      PRODUCT_A,
      expect.objectContaining({
        key: 'sms-notifications',
        name: 'SMS Notifications',
        billingType: 'recurring',
        billingInterval: 'month',
        unitAmountCents: 1900,
      }),
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'INSERT',
        table_name: 'add_ons',
        record_id: ADDON_A,
      }),
    );
  });

  it('400s on an invalid billing_type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/addons',
      payload: {
        productId: PRODUCT_A,
        key: 'k',
        name: 'n',
        billing_type: 'bogus',
        unit_amount_cents: 100,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateAddOn).not.toHaveBeenCalled();
  });

  it('400s when unit_amount_cents is missing (required for add-ons)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/addons',
      payload: {
        productId: PRODUCT_A,
        key: 'k',
        name: 'n',
        billing_type: 'recurring',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s on an invalid billing_interval', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/addons',
      payload: {
        productId: PRODUCT_A,
        key: 'k',
        name: 'n',
        billing_type: 'recurring',
        billing_interval: 'decade',
        unit_amount_cents: 100,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/v1/admin/addons/:addonId (HUB-1652)', () => {
  it('routes patch fields to updateAddOn', async () => {
    mockUpdateAddOn.mockResolvedValueOnce({ ...BASE_ADDON, name: 'Renamed' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/addons/${ADDON_A}`,
      payload: { name: 'Renamed', description: 'refreshed copy' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdateAddOn).toHaveBeenCalledWith(
      ADDON_A,
      expect.objectContaining({ name: 'Renamed', description: 'refreshed copy' }),
      'op-2',
    );
  });

  it('404s a bogus addon id lookup', async () => {
    mockPoolQuery.mockImplementationOnce((sql: string) => {
      expect(sql).toContain('FROM add_ons a');
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/addons/${ADDON_A}`,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(mockUpdateAddOn).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/admin/addons/:addonId (HUB-1652)', () => {
  it('soft-archives via softArchiveAddOn and echoes the row', async () => {
    mockSoftArchiveAddOn.mockResolvedValueOnce({
      ...BASE_ADDON,
      active: false,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/addons/${ADDON_A}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockSoftArchiveAddOn).toHaveBeenCalledWith(ADDON_A, 'op-2');
  });

  it('returns 422 with {activeSubscribers} when the service throws the guard', async () => {
    const err = new AppError(422, 'Add-on has 2 active subscriber(s); archive blocked') as
      AppError & { activeSubscribers: number };
    err.activeSubscribers = 2;
    mockSoftArchiveAddOn.mockRejectedValueOnce(err);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/addons/${ADDON_A}`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ activeSubscribers: 2 });
  });

  it('403s a product_admin whose tenant does not own the addon', async () => {
    const scoped = build('product_admin', TENANT_B);
    await scoped.register(adminAddOnsRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'DELETE',
      url: `/api/v1/admin/addons/${ADDON_A}`,
    });
    expect(res.statusCode).toBe(403);
    await scoped.close();
  });
});
