// Authorized by HUB-1385 (E-CMP-WAVE4 S2, HUB-870) — GRC CRUD route tests.
// Mocks pg pool + emitGrcSignal; drives Fastify.inject() to lock the 11 endpoints'
// response shapes, RBAC guards (super_admin required on mutations, both roles read),
// signal emit vs suppression paths, and 400/404 error branches.
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

import adminGrcRoutes from '../grc.js';
import { AppError } from '../../../errors/AppError.js';

import { closeAppResources } from '../../../__tests__/_testCleanup.js';
const DEVICE_ID = '11111111-1111-1111-1111-111111111111';
const ONB_ID    = '22222222-2222-2222-2222-222222222222';
const OFF_ID    = '33333333-3333-3333-3333-333333333333';

function build(role: 'super_admin' | 'product_admin' = 'super_admin') {
  const instance = Fastify();
  instance.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { operatorUser: unknown }).operatorUser = {
      operator_id: 'op-1',
      role,
      tenant_id: null,
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
  await app.register(adminGrcRoutes);
  await app.ready();

  appProductAdmin = build('product_admin');
  await appProductAdmin.register(adminGrcRoutes);
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
//  Devices
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /devices (AC 1)', () => {
  it('creates a device and returns 201', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: DEVICE_ID, device_name: 'MBP-1' }] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/devices',
      payload: { product_id: 'hub', device_name: 'MBP-1', owner_name: 'Ada', owner_email: 'ada@x' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: DEVICE_ID, device_name: 'MBP-1' });
  });

  it('returns 400 when required field missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/devices',
      payload: { product_id: 'hub' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/device_name/);
  });

  it('returns 403 when product_admin (AC 12)', async () => {
    const res = await appProductAdmin.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/devices',
      payload: { product_id: 'hub', device_name: 'x', owner_name: 'x', owner_email: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /devices (AC 2)', () => {
  it('returns paginated envelope for authenticated operator', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ id: DEVICE_ID, device_name: 'MBP-1' }] });
    const res = await appProductAdmin.inject({ method: 'GET', url: '/api/v1/admin/grc/devices?page=1&pageSize=10' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: expect.any(Array), total: 3, page: 1, pageSize: 10 });
  });

  it('applies status filter when provided', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
    await app.inject({ method: 'GET', url: '/api/v1/admin/grc/devices?status=decommissioned' });
    const countCall = mockPoolQuery.mock.calls[0]!;
    expect(countCall[0]).toMatch(/WHERE status = \$1/);
    // The route reuses the params array between the count + data queries by push()ing
    // limit + offset onto it, so the mock captures the mutated reference. Assert the
    // status filter is at position 0 rather than deep-equalling the whole array.
    expect(countCall[1][0]).toBe('decommissioned');
  });
});

describe('PUT /devices/:id (AC 3)', () => {
  it('returns 404 when device does not exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/grc/devices/${DEVICE_ID}`,
      payload: { device_name: 'renamed' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates provided fields and returns 200', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: DEVICE_ID, device_name: 'renamed' }] });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/grc/devices/${DEVICE_ID}`,
      payload: { device_name: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ device_name: 'renamed' });
  });
});

describe('DELETE /devices/:id (AC 4 soft-delete)', () => {
  it('soft-deletes an active device and returns 200 with decommissioned_at', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: DEVICE_ID, decommissioned_at: '2026-07-05T12:00:00Z' }],
    });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/admin/grc/devices/${DEVICE_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: DEVICE_ID, decommissioned_at: '2026-07-05T12:00:00Z' });
  });

  it('returns 404 when device does not exist', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/admin/grc/devices/${DEVICE_ID}` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when device already decommissioned', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'decommissioned' }] });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/admin/grc/devices/${DEVICE_ID}` });
    expect(res.statusCode).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Device compliance attestation (AC 5, AC 13)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /devices/:id/compliance (AC 5, 13)', () => {
  function mockCompliantFlow() {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM device_inventory WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ product_id: 'hub' }] };
      if (/INSERT INTO device_compliance_records/.test(sql)) {
        return { rows: [{ id: 'rec-1', attested_at: '2026-07-05T12:00:00Z', content_hash: 'a'.repeat(64) }] };
      }
      return { rows: [] };
    });
  }

  it('AC 5: compliant attestation emits a signal via emitGrcSignal', async () => {
    mockCompliantFlow();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/devices/${DEVICE_ID}/compliance`,
      payload: { compliance_type: 'mdm_enrollment', status: 'compliant', attested_by: 'it-lead@x' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockEmitGrcSignal).toHaveBeenCalledTimes(1);
    expect(mockEmitGrcSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productSlug: 'hub',
        controlKey: 'device-mdm-compliance',
        signalType: 'device_compliance_attested',
        entityId: 'rec-1',
      }),
    );
    // COMMIT was reached
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('AC 13: non-compliant attestation inserts record but does NOT emit a signal', async () => {
    mockCompliantFlow();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/devices/${DEVICE_ID}/compliance`,
      payload: { compliance_type: 'mdm_enrollment', status: 'non_compliant', attested_by: 'it-lead@x' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 404 when device does not exist', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM device_inventory WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/devices/${DEVICE_ID}/compliance`,
      payload: { compliance_type: 'mdm_enrollment', status: 'compliant', attested_by: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
  });

  it('returns 400 for unknown compliance_type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/grc/devices/${DEVICE_ID}/compliance`,
      payload: { compliance_type: 'bogus', status: 'compliant', attested_by: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Onboarding
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /onboarding (AC 6)', () => {
  it('creates a record with sla_deadline = hire_date + 7 days', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: ONB_ID, sla_deadline: '2026-07-12' }] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/onboarding',
      payload: {
        product_id: 'hub', employee_name: 'Ada', employee_email: 'ada@x',
        role: 'eng', hire_date: '2026-07-05',
      },
    });
    expect(res.statusCode).toBe(201);
    const call = mockPoolQuery.mock.calls[0]!;
    // 6th positional param is sla_deadline
    expect(call[1][5]).toBe('2026-07-12');
  });
});

describe('POST /onboarding/:id/complete (AC 8)', () => {
  it('completes the record, emits hr_onboarding_completed signal, returns 200', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT product_id, status, completed_at\s+FROM hr_onboarding_records/.test(sql)) {
        return { rows: [{ product_id: 'hub', status: 'pending', completed_at: null }] };
      }
      if (/UPDATE hr_onboarding_records/.test(sql)) {
        return { rows: [{ id: ONB_ID, status: 'completed', completed_at: '2026-07-06T12:00:00Z' }] };
      }
      return { rows: [] };
    });
    const res = await app.inject({ method: 'POST', url: `/api/v1/admin/grc/onboarding/${ONB_ID}/complete` });
    expect(res.statusCode).toBe(200);
    expect(mockEmitGrcSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productSlug: 'hub',
        controlKey: 'hr-onboarding-sla',
        signalType: 'hr_onboarding_completed',
        entityId: ONB_ID,
      }),
    );
  });

  it('returns 409 when already completed', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM hr_onboarding_records/.test(sql)) {
        return { rows: [{ product_id: 'hub', status: 'completed', completed_at: '2026-06-01T00:00:00Z' }] };
      }
      return { rows: [] };
    });
    const res = await app.inject({ method: 'POST', url: `/api/v1/admin/grc/onboarding/${ONB_ID}/complete` });
    expect(res.statusCode).toBe(409);
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
  });

  it('returns 404 when record does not exist', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM hr_onboarding_records/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await app.inject({ method: 'POST', url: `/api/v1/admin/grc/onboarding/${ONB_ID}/complete` });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Offboarding
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /offboarding (AC 9)', () => {
  it('creates a record with revocation_deadline = last_day + 24h', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: OFF_ID }] });
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/grc/offboarding',
      payload: {
        product_id: 'hub', employee_name: 'Bob', employee_email: 'bob@x',
        role: 'eng', last_day: '2026-07-05',
      },
    });
    const call = mockPoolQuery.mock.calls[0]!;
    // 6th positional param is revocation_deadline (ISO with time)
    expect(call[1][5]).toBe('2026-07-06T00:00:00.000Z');
  });
});

describe('PUT /offboarding/:id/checklist (AC 11)', () => {
  function mockCurrentState(state: {
    completed_at: string | null;
    device_returned: boolean;
    accounts_disabled: boolean;
    tokens_revoked: boolean;
  }) {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT product_id, completed_at, device_returned, accounts_disabled, tokens_revoked/.test(sql)) {
        return { rows: [{ product_id: 'hub', ...state }] };
      }
      if (/UPDATE hr_offboarding_records SET/.test(sql) && !sql.includes("status = 'completed'")) {
        // reflect the incoming values from the params + previous state
        return { rows: [{ id: OFF_ID, product_id: 'hub', ...state,
          device_returned: true, accounts_disabled: true, tokens_revoked: true, completed_at: null }] };
      }
      if (/UPDATE hr_offboarding_records[\s\S]*status = 'completed'/.test(sql)) {
        return { rows: [{ id: OFF_ID, status: 'completed', completed_at: '2026-07-05T12:00:00Z' }] };
      }
      return { rows: [] };
    });
  }

  it('partial checklist does NOT emit signal', async () => {
    mockCurrentState({ completed_at: null, device_returned: false, accounts_disabled: false, tokens_revoked: false });
    // Override the update return to reflect a partial state
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT product_id, completed_at/.test(sql)) {
        return { rows: [{ product_id: 'hub', completed_at: null, device_returned: false, accounts_disabled: false, tokens_revoked: false }] };
      }
      if (/UPDATE hr_offboarding_records SET/.test(sql)) {
        return { rows: [{ id: OFF_ID, product_id: 'hub', device_returned: true, accounts_disabled: false, tokens_revoked: false, completed_at: null }] };
      }
      return { rows: [] };
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/grc/offboarding/${OFF_ID}/checklist`,
      payload: { device_returned: true },
    });
    expect(res.statusCode).toBe(200);
    expect(mockEmitGrcSignal).not.toHaveBeenCalled();
  });

  it('all-three-true auto-completes and emits hr_offboarding_completed signal', async () => {
    mockCurrentState({ completed_at: null, device_returned: false, accounts_disabled: false, tokens_revoked: false });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/grc/offboarding/${OFF_ID}/checklist`,
      payload: { device_returned: true, accounts_disabled: true, tokens_revoked: true },
    });
    expect(res.statusCode).toBe(200);
    expect(mockEmitGrcSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productSlug: 'hub',
        controlKey: 'hr-offboarding-24h',
        signalType: 'hr_offboarding_completed',
        entityId: OFF_ID,
      }),
    );
  });

  it('returns 400 for invalid field type', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/grc/offboarding/${OFF_ID}/checklist`,
      payload: { device_returned: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when record does not exist', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (/FROM hr_offboarding_records/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/grc/offboarding/${OFF_ID}/checklist`,
      payload: { device_returned: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Role enforcement (AC 12)
// ─────────────────────────────────────────────────────────────────────────────

describe('super_admin gate on mutations (AC 12)', () => {
  const mutations: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string; payload?: Record<string, unknown> }> = [
    { method: 'POST', url: '/api/v1/admin/grc/devices', payload: { product_id: 'hub', device_name: 'x', owner_name: 'x', owner_email: 'x' } },
    { method: 'PUT', url: `/api/v1/admin/grc/devices/${DEVICE_ID}`, payload: { device_name: 'x' } },
    { method: 'DELETE', url: `/api/v1/admin/grc/devices/${DEVICE_ID}` },
    { method: 'POST', url: `/api/v1/admin/grc/devices/${DEVICE_ID}/compliance`, payload: { compliance_type: 'mdm_enrollment', status: 'compliant', attested_by: 'x' } },
    { method: 'POST', url: '/api/v1/admin/grc/onboarding', payload: { product_id: 'hub', employee_name: 'x', employee_email: 'x', role: 'x', hire_date: '2026-07-05' } },
    { method: 'POST', url: `/api/v1/admin/grc/onboarding/${ONB_ID}/complete` },
    { method: 'POST', url: '/api/v1/admin/grc/offboarding', payload: { product_id: 'hub', employee_name: 'x', employee_email: 'x', role: 'x', last_day: '2026-07-05' } },
    { method: 'PUT', url: `/api/v1/admin/grc/offboarding/${OFF_ID}/checklist`, payload: { device_returned: true } },
  ];

  for (const m of mutations) {
    it(`${m.method} ${m.url} → 403 for product_admin`, async () => {
      const res = await appProductAdmin.inject({
        method: m.method,
        url: m.url,
        payload: m.payload as never,
      });
      expect(res.statusCode).toBe(403);
    });
  }
});
