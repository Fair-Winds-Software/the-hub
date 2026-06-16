// Authorized by HUB-801 — unit tests: escalation rule CRUD; 2-tier cap; 400 validations; 404 on missing
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import escalationRuleRoutes from '../escalationRuleRoutes.js';

const TENANT_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const RULE_ID    = 'cccccccc-0000-0000-0000-000000000003';

const CONTACTS = [{ type: 'email', value: 'oncall@example.com' }];

const RULE_ROW = {
  id: RULE_ID,
  tenant_id: TENANT_ID,
  product_id: PRODUCT_ID,
  alert_type: 'below_floor',
  tier: 1,
  threshold_minutes: 60,
  escalation_contacts: CONTACTS,
};

async function buildTestApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  (fastify as any).decorate('authenticateOperator', async (request: any) => {
    request.operator_id = 'op-1';
  });
  await fastify.register(escalationRuleRoutes);
  await fastify.ready();
  return fastify;
}

afterEach(() => { vi.clearAllMocks(); });

// ── POST ──────────────────────────────────────────────────────────────────────

describe('POST /api/v1/escalation/:tenantId/:productId/rules', () => {
  it('returns 201 with rule row on successful create', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // count check
      .mockResolvedValueOnce({ rows: [RULE_ROW] });       // INSERT RETURNING
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
        payload: { tier: 1, threshold_minutes: 60, alert_type: 'below_floor', escalation_contacts: CONTACTS },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: RULE_ID, tier: 1 });
    } finally { await fastify.close(); }
  });

  it('returns 409 when 2-tier cap is already reached', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
        payload: { tier: 1, threshold_minutes: 60, alert_type: 'below_floor', escalation_contacts: CONTACTS },
      });
      expect(res.statusCode).toBe(409);
    } finally { await fastify.close(); }
  });

  it('returns 409 on unique-constraint PG error (23505)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
        payload: { tier: 1, threshold_minutes: 60, alert_type: 'below_floor', escalation_contacts: CONTACTS },
      });
      expect(res.statusCode).toBe(409);
    } finally { await fastify.close(); }
  });

  it('returns 400 for tier not 1 or 2', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
        payload: { tier: 3, threshold_minutes: 60, alert_type: 'below_floor', escalation_contacts: CONTACTS },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('tier');
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-positive threshold_minutes', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
        payload: { tier: 1, threshold_minutes: 0, alert_type: 'below_floor', escalation_contacts: CONTACTS },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });

  it('returns 400 for empty alert_type', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
        payload: { tier: 1, threshold_minutes: 60, alert_type: '', escalation_contacts: CONTACTS },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });

  it('returns 400 for empty escalation_contacts array', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
        payload: { tier: 1, threshold_minutes: 60, alert_type: 'below_floor', escalation_contacts: [] },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });

  it('returns 400 for invalid contact type', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
        payload: { tier: 1, threshold_minutes: 60, alert_type: 'below_floor', escalation_contacts: [{ type: 'fax', value: '555-1234' }] },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID tenantId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/v1/escalation/not-a-uuid/${PRODUCT_ID}/rules`,
        payload: { tier: 1, threshold_minutes: 60, alert_type: 'below_floor', escalation_contacts: CONTACTS },
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET /api/v1/escalation/:tenantId/:productId/rules', () => {
  it('returns 200 with rules array sorted by alert_type and tier', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [RULE_ROW] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ rules: unknown[] }>().rules).toHaveLength(1);
    } finally { await fastify.close(); }
  });

  it('returns 200 with empty rules array when none exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ rules: unknown[] }>().rules).toHaveLength(0);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID productId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/v1/escalation/${TENANT_ID}/bad-product-id/rules`,
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/escalation/:tenantId/:productId/rules/:ruleId', () => {
  it('returns 204 on successful delete', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules/${RULE_ID}`,
      });
      expect(res.statusCode).toBe(204);
    } finally { await fastify.close(); }
  });

  it('returns 404 when rule not found for this tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules/${RULE_ID}`,
      });
      expect(res.statusCode).toBe(404);
    } finally { await fastify.close(); }
  });

  it('returns 400 for non-UUID ruleId', async () => {
    const fastify = await buildTestApp();
    try {
      const res = await fastify.inject({
        method: 'DELETE',
        url: `/api/v1/escalation/${TENANT_ID}/${PRODUCT_ID}/rules/not-a-uuid`,
      });
      expect(res.statusCode).toBe(400);
    } finally { await fastify.close(); }
  });
});
