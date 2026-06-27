// Authorized by HUB-1594 (E-BE-1 S11, CR-1) — unit tests for the Jira tickets endpoint and the
// admin token-rotation recovery endpoint. Tests register the route plugin on a bare Fastify
// instance (no operatorRbacHook upstream — handlers receive the mocked request.operatorUser
// directly via a preHandler) and use `inject` to drive HTTP.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockGetTicketCounts = vi.hoisted(() => vi.fn());
const mockClearAuthCache = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../services/jiraIntegrationService.js', () => ({
  getTicketCounts: mockGetTicketCounts,
  clearAuthCache: mockClearAuthCache,
}));

import adminIntegrationRoutes from '../integrations.js';
import { AppError } from '../../../errors/AppError.js';

let app: FastifyInstance;

interface Role {
  role: 'super_admin' | 'product_admin';
}

function build(role: Role['role'] = 'super_admin') {
  const instance = Fastify();
  // Stand-in for operatorRbacHook: synthesize request.operatorUser per test.
  instance.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { operatorUser: unknown }).operatorUser = {
      operator_id: 'op-1',
      role,
      tenant_id: null,
    };
    done();
  });
  // Mirror HUB's AppError → JSON response shape.
  instance.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  return instance;
}

beforeAll(async () => {
  app = build();
  await app.register(adminIntegrationRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/admin/integrations/jira/tickets (HUB-1594)', () => {
  it('returns 200 with the available:true success payload from the service', async () => {
    mockGetTicketCounts.mockResolvedValueOnce({
      available: true,
      openCRs: 3,
      openBugs: 7,
      lastSyncedAt: '2026-06-27T01:00:00.000Z',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/integrations/jira/tickets?productId=contenthelm',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      available: true,
      openCRs: 3,
      openBugs: 7,
      lastSyncedAt: '2026-06-27T01:00:00.000Z',
    });
    expect(mockGetTicketCounts).toHaveBeenCalledWith('contenthelm');
  });

  it('passes degraded {available:false} responses through unchanged with status 200', async () => {
    mockGetTicketCounts.mockResolvedValueOnce({ available: false, reason: 'rate_limited' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/integrations/jira/tickets?productId=hub',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: 'rate_limited' });
  });

  it('returns 200 + product_not_mapped from the service for an unmapped key', async () => {
    mockGetTicketCounts.mockResolvedValueOnce({ available: false, reason: 'product_not_mapped' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/integrations/jira/tickets?productId=unknown',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, reason: 'product_not_mapped' });
  });

  it('returns 400 MISSING_PRODUCT_ID when productId query param is absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/integrations/jira/tickets',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'MISSING_PRODUCT_ID' });
    expect(mockGetTicketCounts).not.toHaveBeenCalled();
  });

  it('returns 400 when productId is the empty string', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/integrations/jira/tickets?productId=',
    });

    expect(res.statusCode).toBe(400);
    expect(mockGetTicketCounts).not.toHaveBeenCalled();
  });

  it('returns 400 when productId is whitespace only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/integrations/jira/tickets?productId=%20%20',
    });

    expect(res.statusCode).toBe(400);
    expect(mockGetTicketCounts).not.toHaveBeenCalled();
  });

  it('product_admin is allowed to GET tickets (read-only, no PII)', async () => {
    const productInstance = build('product_admin');
    await productInstance.register(adminIntegrationRoutes);
    await productInstance.ready();

    mockGetTicketCounts.mockResolvedValueOnce({
      available: true,
      openCRs: 1,
      openBugs: 2,
      lastSyncedAt: '2026-06-27T00:00:00.000Z',
    });

    const res = await productInstance.inject({
      method: 'GET',
      url: '/api/v1/admin/integrations/jira/tickets?productId=hub',
    });
    expect(res.statusCode).toBe(200);
    await productInstance.close();
  });
});

describe('POST /api/v1/admin/integrations/jira/refresh-token-cache (HUB-1594)', () => {
  it('returns 200 success: true and calls clearAuthCache for super_admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/integrations/jira/refresh-token-cache',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mockClearAuthCache).toHaveBeenCalledTimes(1);
  });

  it('returns 403 Forbidden for product_admin', async () => {
    const productInstance = build('product_admin');
    await productInstance.register(adminIntegrationRoutes);
    await productInstance.ready();

    const res = await productInstance.inject({
      method: 'POST',
      url: '/api/v1/admin/integrations/jira/refresh-token-cache',
    });

    expect(res.statusCode).toBe(403);
    expect(mockClearAuthCache).not.toHaveBeenCalled();
    await productInstance.close();
  });
});
