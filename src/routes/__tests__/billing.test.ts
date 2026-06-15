// Authorized by HUB-454 — unit tests: GET /api/v1/billing/subscriptions/:tenantId
// Authorized by HUB-476 — unit tests: GET /api/v1/billing/invoices/:tenantId
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockGetSubscriptions = vi.hoisted(() => vi.fn());
vi.mock('../../services/stripeService.js', () => ({
  getSubscriptions: mockGetSubscriptions,
}));

const mockGetInvoices = vi.hoisted(() => vi.fn());
vi.mock('../../services/invoiceService.js', () => ({
  getInvoices: mockGetInvoices,
}));

import billingRoutes from '../billing.js';

async function buildTestApp() {
  const fastify = Fastify({ logger: false });
  fastify.decorate(
    'authenticateOperator',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      request.operator_id = 'op-1';
      request.operator_role = 'admin';
    },
  );
  await fastify.register(billingRoutes);
  return fastify;
}

afterEach(() => {
  vi.clearAllMocks();
});

const VALID_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('GET /api/v1/billing/subscriptions/:tenantId', () => {
  it('returns 200 with { data } envelope on success', async () => {
    const rows = [{ id: 'sub-row-1', stripe_subscription_id: 'sub_1', status: 'active' }];
    mockGetSubscriptions.mockResolvedValueOnce(rows);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/billing/subscriptions/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: unknown[] }>();
      expect(body.data).toHaveLength(1);
    } finally {
      await fastify.close();
    }
  });

  it('returns empty data array when tenant has no subscriptions', async () => {
    mockGetSubscriptions.mockResolvedValueOnce([]);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/billing/subscriptions/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: unknown[] }>().data).toEqual([]);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when tenantId is not a valid UUID', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/billing/subscriptions/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('passes the tenantId to getSubscriptions', async () => {
    mockGetSubscriptions.mockResolvedValueOnce([]);

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/billing/subscriptions/${VALID_UUID}`,
      });
      expect(mockGetSubscriptions).toHaveBeenCalledWith(VALID_UUID);
    } finally {
      await fastify.close();
    }
  });
});

describe('GET /api/v1/billing/invoices/:tenantId', () => {
  it('returns 200 with { data } envelope on success', async () => {
    const rows = [{ id: 'inv-1', stripe_invoice_id: 'in_1', status: 'paid' }];
    mockGetInvoices.mockResolvedValueOnce(rows);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/billing/invoices/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: unknown[] }>().data).toHaveLength(1);
    } finally {
      await fastify.close();
    }
  });

  it('returns empty data array when tenant has no invoices', async () => {
    mockGetInvoices.mockResolvedValueOnce([]);

    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/billing/invoices/${VALID_UUID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: unknown[] }>().data).toEqual([]);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when tenantId is not a valid UUID', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: '/api/v1/billing/invoices/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('returns 400 when productId query param is not a valid UUID', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/billing/invoices/${VALID_UUID}?productId=not-a-uuid`,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await fastify.close();
    }
  });

  it('passes tenantId and productId to getInvoices', async () => {
    mockGetInvoices.mockResolvedValueOnce([]);
    const productUUID = 'bbbbbbbb-0000-0000-0000-000000000002';

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/billing/invoices/${VALID_UUID}?productId=${productUUID}`,
      });
      expect(mockGetInvoices).toHaveBeenCalledWith(VALID_UUID, productUUID, undefined);
    } finally {
      await fastify.close();
    }
  });

  it('passes parsed limit to getInvoices', async () => {
    mockGetInvoices.mockResolvedValueOnce([]);

    const fastify = await buildTestApp();
    try {
      await fastify.inject({
        method: 'GET',
        url: `/api/v1/billing/invoices/${VALID_UUID}?limit=5`,
      });
      expect(mockGetInvoices).toHaveBeenCalledWith(VALID_UUID, undefined, 5);
    } finally {
      await fastify.close();
    }
  });
});
