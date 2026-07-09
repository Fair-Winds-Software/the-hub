// Authorized by HUB-1423 (E-CMP-WAVE4b S2, HUB-871) — route tests for the 13 GRC
// vendor/cloud/policy endpoints. Covers happy paths, signal emission on positive
// events, AC 14 signal-suppression on cloud attestation with status='fail'/'partial',
// AC 13 policy acknowledge accessible to product_admin (not gated on super_admin),
// and super_admin gate on the 12 admin mutations.
import {
  describe, it, expect, vi, beforeAll, afterAll, beforeEach,
} from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockClientQuery = vi.hoisted(() => vi.fn());
const mockClientRelease = vi.hoisted(() => vi.fn());
const mockPoolConnect = vi.hoisted(() =>
  vi.fn().mockImplementation(() => Promise.resolve({
    query: mockClientQuery,
    release: mockClientRelease,
  })),
);
vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: mockPoolConnect }),
}));

const mockEmitGrcSignal = vi.hoisted(() => vi.fn().mockResolvedValue({ emitted: true, signalEvidenceId: 'evi-1' }));
vi.mock('../../../services/grcSignalService.js', () => ({
  emitGrcSignal: mockEmitGrcSignal,
}));

vi.mock('../../../lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import adminGrcVendorCloudPolicyRoutes from '../grcVendorCloudPolicy.js';
import { AppError } from '../../../errors/AppError.js';

import { closeAppResources } from '../../../__tests__/_testCleanup.js';
const VENDOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLOUD_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const POLICY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function build(role: 'super_admin' | 'product_admin' = 'super_admin') {
  const instance = Fastify();
  instance.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { operatorUser: unknown }).operatorUser = {
      operator_id: 'op-1', role, tenant_id: null,
    };
    done();
  });
  instance.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.message });
    return reply.status(500).send({ error: 'internal' });
  });
  return instance;
}

let app: FastifyInstance;
let appProductAdmin: FastifyInstance;

beforeAll(async () => {
  app = build('super_admin');
  await app.register(adminGrcVendorCloudPolicyRoutes);
  await app.ready();
  appProductAdmin = build('product_admin');
  await appProductAdmin.register(adminGrcVendorCloudPolicyRoutes);
  await appProductAdmin.ready();
});

afterAll(async () => {
  await closeAppResources(app);
  await appProductAdmin.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitGrcSignal.mockResolvedValue({ emitted: true, signalEvidenceId: 'evi-1' });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Vendor
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /vendors (AC 1)', () => {
  it('creates a vendor + returns 201', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: VENDOR_ID, vendor_name: 'Acme' }] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/vendors',
      payload: { vendor_name: 'Acme', vendor_type: 'saas' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: VENDOR_ID });
  });

  it('returns 400 on missing vendor_name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/vendors',
      payload: { vendor_type: 'saas' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on invalid vendor_type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/vendors',
      payload: { vendor_name: 'Acme', vendor_type: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /vendors (AC 2) — pagination + filters', () => {
  it('returns paginated envelope', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ id: VENDOR_ID }] });
    const res = await appProductAdmin.inject({
      method: 'GET', url: '/api/v1/admin/grc/vendors?page=1&pageSize=10',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 2, page: 1, pageSize: 10 });
  });

  it('applies status + risk_level filters', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
    await app.inject({ method: 'GET', url: '/api/v1/admin/grc/vendors?status=active&risk_level=high' });
    const countCall = mockPoolQuery.mock.calls[0]!;
    expect(countCall[0]).toMatch(/status = \$1/);
    expect(countCall[0]).toMatch(/risk_level = \$2/);
  });
});

describe('PUT /vendors/:id (AC 3)', () => {
  it('returns 404 when vendor does not exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/grc/vendors/${VENDOR_ID}`,
      payload: { vendor_name: 'renamed' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when no updatable fields provided', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/grc/vendors/${VENDOR_ID}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /vendors/:id (AC 4 soft-delete)', () => {
  it('soft-deletes active vendor → 200 with archived status', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: VENDOR_ID, status: 'archived', updated_at: '2026-07-05T00:00:00Z' }],
    });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/admin/grc/vendors/${VENDOR_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'archived' });
  });

  it('returns 409 when already archived', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'archived' }] });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/admin/grc/vendors/${VENDOR_ID}` });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /vendors/:id/assessment (AC 5)', () => {
  function mockAssessmentFlow() {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM vendor_register WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ id: VENDOR_ID }] };
      if (/INSERT INTO vendor_risk_assessments/.test(sql)) {
        return { rows: [{ id: 'assess-1', created_at: '2026-07-05T12:00:00Z', content_hash: 'a'.repeat(64) }] };
      }
      return { rows: [] };
    });
  }

  it('AC 5: assessment emits vendor_risk_assessed signal on portfolio product', async () => {
    mockAssessmentFlow();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/vendors/${VENDOR_ID}/assessment`,
      payload: { risk_score: 42, assessed_by: 'auditor@x' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockEmitGrcSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productSlug: 'hub-portfolio',
        controlKey: 'vendor-risk-review',
        signalType: 'vendor_risk_assessed',
        entityId: 'assess-1',
      }),
    );
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 400 when risk_score is out of range', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/vendors/${VENDOR_ID}/assessment`,
      payload: { risk_score: 150, assessed_by: 'auditor@x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when vendor does not exist', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM vendor_register/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/vendors/${VENDOR_ID}/assessment`,
      payload: { risk_score: 42, assessed_by: 'auditor@x' },
    });
    expect(res.statusCode).toBe(404);
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Cloud
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /cloud (AC 6)', () => {
  it('creates a cloud account + returns 201', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: CLOUD_ID, provider: 'aws' }] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/cloud',
      payload: { account_name: 'prod-us-east', provider: 'aws' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: CLOUD_ID });
  });

  it('returns 400 on invalid provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/cloud',
      payload: { account_name: 'x', provider: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /cloud/:id/attestation (AC 9, 14)', () => {
  function mockAttestationFlow() {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM cloud_infrastructure WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ id: CLOUD_ID }] };
      if (/INSERT INTO cloud_security_attestations/.test(sql)) {
        return { rows: [{ id: 'att-1', created_at: '2026-07-05T12:00:00Z', content_hash: 'b'.repeat(64) }] };
      }
      return { rows: [] };
    });
  }

  it('AC 9: pass status emits cloud_security_attested signal', async () => {
    mockAttestationFlow();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/cloud/${CLOUD_ID}/attestation`,
      payload: { attestation_type: 'mfa_enforcement', status: 'pass', attested_by: 'auditor@x' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockEmitGrcSignal).toHaveBeenCalledTimes(1);
    expect(mockEmitGrcSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productSlug: 'hub-portfolio',
        controlKey: 'cloud-security-audit',
        signalType: 'cloud_security_attested',
      }),
    );
  });

  it('AC 14: fail status inserts record but does NOT emit signal', async () => {
    mockAttestationFlow();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/cloud/${CLOUD_ID}/attestation`,
      payload: { attestation_type: 'mfa_enforcement', status: 'fail', attested_by: 'auditor@x' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('AC 14: partial status inserts record but does NOT emit signal', async () => {
    mockAttestationFlow();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/cloud/${CLOUD_ID}/attestation`,
      payload: { attestation_type: 'mfa_enforcement', status: 'partial', attested_by: 'auditor@x' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/cloud/${CLOUD_ID}/attestation`,
      payload: { attestation_type: 'x', status: 'maybe', attested_by: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Policy
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /policies (AC 10)', () => {
  it('creates a policy + returns 201', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: POLICY_ID, policy_name: 'AUP' }] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/policies',
      payload: { policy_name: 'AUP', policy_type: 'acceptable_use', version: 'v1.0' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 400 on invalid policy_type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/policies',
      payload: { policy_name: 'x', policy_type: 'bogus', version: 'v1' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /policies/:id/acknowledge (AC 13)', () => {
  function mockAckFlow() {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM policy_register WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ id: POLICY_ID }] };
      if (/INSERT INTO policy_acknowledgments/.test(sql)) {
        return { rows: [{ id: 'ack-1', created_at: '2026-07-05T12:00:00Z', content_hash: 'c'.repeat(64) }] };
      }
      return { rows: [] };
    });
  }

  it('AC 13: super_admin can acknowledge → emits policy_acknowledged signal', async () => {
    mockAckFlow();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/policies/${POLICY_ID}/acknowledge`,
      payload: { employee_id: 'emp-1', employee_name: 'Ada', policy_version: 'v1.0' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockEmitGrcSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productSlug: 'hub-portfolio',
        controlKey: 'policy-acknowledgment',
        signalType: 'policy_acknowledged',
      }),
    );
  });

  it('product_admin cannot acknowledge — Wave 4b is super_admin-only', async () => {
    mockAckFlow();
    const res = await appProductAdmin.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/policies/${POLICY_ID}/acknowledge`,
      payload: { employee_id: 'emp-2', employee_name: 'Bob', policy_version: 'v1.0' },
    });
    expect(res.statusCode).toBe(403);
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
  });

  it('returns 404 when policy does not exist', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM policy_register/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/policies/${POLICY_ID}/acknowledge`,
      payload: { employee_id: 'x', employee_name: 'x', policy_version: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Role enforcement (AC 15)
// ─────────────────────────────────────────────────────────────────────────────

describe('super_admin gate on admin mutations (AC 15)', () => {
  const mutations: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string; payload?: Record<string, unknown> }> = [
    { method: 'POST', url: '/api/v1/admin/grc/vendors', payload: { vendor_name: 'x', vendor_type: 'saas' } },
    { method: 'PUT', url: `/api/v1/admin/grc/vendors/${VENDOR_ID}`, payload: { vendor_name: 'x' } },
    { method: 'DELETE', url: `/api/v1/admin/grc/vendors/${VENDOR_ID}` },
    { method: 'POST', url: `/api/v1/admin/grc/vendors/${VENDOR_ID}/assessment`, payload: { risk_score: 50, assessed_by: 'x' } },
    { method: 'POST', url: '/api/v1/admin/grc/cloud', payload: { account_name: 'x', provider: 'aws' } },
    { method: 'PUT', url: `/api/v1/admin/grc/cloud/${CLOUD_ID}`, payload: { account_name: 'x' } },
    { method: 'POST', url: `/api/v1/admin/grc/cloud/${CLOUD_ID}/attestation`, payload: { attestation_type: 'x', status: 'pass', attested_by: 'x' } },
    { method: 'POST', url: '/api/v1/admin/grc/policies', payload: { policy_name: 'x', policy_type: 'security', version: 'v1' } },
    { method: 'PUT', url: `/api/v1/admin/grc/policies/${POLICY_ID}`, payload: { policy_name: 'x' } },
  ];

  for (const m of mutations) {
    it(`${m.method} ${m.url} → 403 for product_admin`, async () => {
      const res = await appProductAdmin.inject({
        method: m.method, url: m.url, payload: m.payload as never,
      });
      expect(res.statusCode).toBe(403);
    });
  }
});
