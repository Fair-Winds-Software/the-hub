// Authorized by HUB-1686 (E-FE-13 S1) — failedPayments route integration
// tests. Mocks the pg pool + stripeService + emailHandler + writeAudit
// and drives Fastify.inject() to lock the response shapes + RBAC gates
// + retry idempotency (409 in-flight) + override-reason validation +
// bulk-email super_admin gate.
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

const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockRetryInvoicePayment = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'paid', amountPaid: 25000 }),
);
const mockSendEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWriteAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));
vi.mock('../../../services/stripeService.js', () => ({
  retryInvoicePayment: mockRetryInvoicePayment,
}));
vi.mock('../../../services/notifications/emailHandler.js', () => ({
  sendEmail: mockSendEmail,
}));
vi.mock('../../../services/auditLogService.js', () => ({
  writeAuditEntry: mockWriteAudit,
}));

import adminFailedPaymentsRoutes, {
  _resetFailedPaymentsCache,
} from '../failedPayments.js';
import { AppError } from '../../../errors/AppError.js';

import { closeAppResources } from '../../../__tests__/_testCleanup.js';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const INVOICE_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

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
  await app.register(adminFailedPaymentsRoutes);
  await app.ready();
});

afterAll(async () => {
  await closeAppResources(app);
});

const FAILED_ROW = {
  id: INVOICE_ID,
  stripe_invoice_id: 'in_test_1',
  stripe_subscription_id: 'sub_test_1',
  tenant_id: TENANT_A,
  tenant_name: 'Acme',
  product_id: PRODUCT_A,
  amount_due: 25000,
  amount_paid: 0,
  currency: 'usd',
  attempt_count: 1,
  max_attempts: 3,
  next_retry_at: null,
  last_retry_triggered_at: null,
  payment_failed_at: new Date('2026-07-01T00:00:00.000Z'),
  overridden_at: null,
  overridden_by: null,
  override_reason: null,
  hub_state: 'pending_retry' as const,
  created_at: new Date('2026-07-01T00:00:00.000Z'),
  delta_data: { failureReason: 'card_declined' },
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetFailedPaymentsCache();
  mockPoolQuery.mockResolvedValue({ rows: [] });
  mockRetryInvoicePayment.mockResolvedValue({ status: 'paid', amountPaid: 25000 });
  mockSendEmail.mockResolvedValue(undefined);
});

describe('GET /api/v1/admin/billing/failed-payments (HUB-1686)', () => {
  it('returns rows with derived hub_state + default 30d window', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM invoices i')) {
        return Promise.resolve({ rows: [FAILED_ROW] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/billing/failed-payments',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: INVOICE_ID,
      tenantName: 'Acme',
      productId: PRODUCT_A,
      amountCents: 25000,
      status: 'pending_retry',
      failureReason: 'card_declined',
    });
  });

  it('cache: second call within 1min reuses payload', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await app.inject({
      method: 'GET',
      url: '/api/v1/admin/billing/failed-payments',
    });
    const firstCalls = mockPoolQuery.mock.calls.length;
    await app.inject({
      method: 'GET',
      url: '/api/v1/admin/billing/failed-payments',
    });
    expect(mockPoolQuery.mock.calls.length).toBe(firstCalls);
  });

  it('?fresh=true bypasses cache', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await app.inject({
      method: 'GET',
      url: '/api/v1/admin/billing/failed-payments',
    });
    const firstCalls = mockPoolQuery.mock.calls.length;
    await app.inject({
      method: 'GET',
      url: '/api/v1/admin/billing/failed-payments?fresh=true',
    });
    expect(mockPoolQuery.mock.calls.length).toBeGreaterThan(firstCalls);
  });

  it('product_admin: SQL filter includes tenant_id scope', async () => {
    const scoped = build('product_admin', TENANT_A);
    await scoped.register(adminFailedPaymentsRoutes);
    await scoped.ready();
    _resetFailedPaymentsCache();
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    mockPoolQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM invoices i')) {
        capturedSql = sql;
        capturedParams = params;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    await scoped.inject({
      method: 'GET',
      url: '/api/v1/admin/billing/failed-payments',
    });
    expect(capturedSql).toContain('i.tenant_id');
    expect(capturedParams).toContain(TENANT_A);
    await scoped.close();
  });
});

describe('GET /api/v1/admin/billing/failed-payments/:id (HUB-1686)', () => {
  it('super_admin drill-in returns full row + retry history', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM invoices i')) {
        return Promise.resolve({ rows: [FAILED_ROW] });
      }
      if (sql.includes('FROM stripe_webhook_events')) {
        return Promise.resolve({
          rows: [
            {
              received_at: new Date('2026-06-30T00:00:00.000Z'),
              raw_event: {
                data: {
                  object: {
                    last_payment_error: {
                      decline_code: 'insufficient_funds',
                      message: 'Your card has insufficient funds.',
                    },
                  },
                },
              },
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/billing/failed-payments/${INVOICE_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stripeSubscriptionId).toBe('sub_test_1');
    expect(body.retryHistory).toHaveLength(1);
    expect(body.retryHistory[0].declineCode).toBe('insufficient_funds');
  });

  it('product_admin drill-in on out-of-scope invoice: 404 (not 403 — no existence leak)', async () => {
    const scoped = build('product_admin', TENANT_B);
    await scoped.register(adminFailedPaymentsRoutes);
    await scoped.ready();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const res = await scoped.inject({
      method: 'GET',
      url: `/api/v1/admin/billing/failed-payments/${INVOICE_ID}`,
    });
    expect(res.statusCode).toBe(404);
    await scoped.close();
  });
});

describe('POST /:id/retry — idempotency contract (HUB-1686)', () => {
  it('first retry: 202 + calls stripeService + writes audit + increments attempt_count', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM invoices i')) {
        return Promise.resolve({ rows: [FAILED_ROW] });
      }
      if (sql.includes('UPDATE invoices')) {
        return Promise.resolve({
          rows: [
            {
              attempt_count: 2,
              last_retry_triggered_at: new Date('2026-07-03T18:00:00.000Z'),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/billing/failed-payments/${INVOICE_ID}/retry`,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.attemptCount).toBe(2);
    expect(body.stripeStatus).toBe('paid');
    expect(mockRetryInvoicePayment).toHaveBeenCalledOnce();
    expect(mockWriteAudit).toHaveBeenCalledOnce();
    expect(mockWriteAudit.mock.calls[0]![0]!.new_values).toMatchObject({
      action: 'payment_retry_triggered',
    });
  });

  it('retry within 30s of last trigger → 409 retry_in_flight (no stripe call, no double-charge)', async () => {
    const inFlightRow = {
      ...FAILED_ROW,
      last_retry_triggered_at: new Date(Date.now() - 5000),
    };
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM invoices i')) {
        return Promise.resolve({ rows: [inFlightRow] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/billing/failed-payments/${INVOICE_ID}/retry`,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('retry_in_flight');
    // The critical assertion — no double-charge — stripe was NOT called.
    expect(mockRetryInvoicePayment).not.toHaveBeenCalled();
  });

  it('product_admin retry on out-of-scope invoice: 404', async () => {
    const scoped = build('product_admin', TENANT_B);
    await scoped.register(adminFailedPaymentsRoutes);
    await scoped.ready();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const res = await scoped.inject({
      method: 'POST',
      url: `/api/v1/admin/billing/failed-payments/${INVOICE_ID}/retry`,
    });
    expect(res.statusCode).toBe(404);
    expect(mockRetryInvoicePayment).not.toHaveBeenCalled();
    await scoped.close();
  });
});

describe('POST /:id/override (HUB-1686)', () => {
  it('reason under 20 chars: 422 with reason length in body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/billing/failed-payments/${INVOICE_ID}/override`,
      payload: { reason: 'too short' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('override_reason_too_short');
  });

  it('valid reason: writes override columns + audit entry with warn severity', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM invoices i')) {
        return Promise.resolve({ rows: [FAILED_ROW] });
      }
      if (sql.includes('UPDATE invoices')) {
        return Promise.resolve({
          rows: [{ overridden_at: new Date('2026-07-03T18:00:00.000Z') }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/billing/failed-payments/${INVOICE_ID}/override`,
      payload: {
        reason: 'Customer contacted; will re-invoice next cycle',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockWriteAudit).toHaveBeenCalledOnce();
    const audit = mockWriteAudit.mock.calls[0]![0]!;
    expect(audit.severity).toBe('warn');
    expect(audit.new_values.action).toBe('payment_override');
    expect(audit.new_values.reason).toContain('re-invoice');
  });

  it('already-overridden invoice: 409', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM invoices i')) {
        return Promise.resolve({ rows: [FAILED_ROW] });
      }
      if (sql.includes('UPDATE invoices')) {
        return Promise.resolve({ rows: [] }); // RETURNING empty = WHERE clause matched nothing
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/billing/failed-payments/${INVOICE_ID}/override`,
      payload: {
        reason: 'Customer contacted; will re-invoice next cycle',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_overridden');
  });
});

describe('POST /bulk-email (HUB-1686 — super_admin gate)', () => {
  it('product_admin: 403 regardless of ids', async () => {
    const scoped = build('product_admin', TENANT_A);
    await scoped.register(adminFailedPaymentsRoutes);
    await scoped.ready();
    const res = await scoped.inject({
      method: 'POST',
      url: '/api/v1/admin/billing/failed-payments/bulk-email',
      payload: { ids: [INVOICE_ID] },
    });
    expect(res.statusCode).toBe(403);
    expect(mockSendEmail).not.toHaveBeenCalled();
    await scoped.close();
  });

  it('over 50 recipients: 422 too_many_recipients', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/billing/failed-payments/bulk-email',
      payload: { ids },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('too_many_recipients');
  });

  it('super_admin: sends emails + reports per-invoice failures', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT i.id, i.tenant_id')) {
        return Promise.resolve({
          rows: [
            {
              id: INVOICE_ID,
              tenant_id: TENANT_A,
              tenant_name: 'Acme',
              product_id: PRODUCT_A,
              amount_due: 25000,
              currency: 'usd',
              customer_email: 'billing@acme.example',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/billing/failed-payments/bulk-email',
      payload: { ids: [INVOICE_ID] },
    });
    expect(res.statusCode).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledOnce();
    const body = res.json();
    expect(body.sent).toBe(1);
    expect(body.failed).toEqual([]);
  });

  it('missing customer_email: surfaces as per-invoice failure', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT i.id, i.tenant_id')) {
        return Promise.resolve({
          rows: [
            {
              id: INVOICE_ID,
              tenant_id: TENANT_A,
              tenant_name: 'Acme',
              product_id: PRODUCT_A,
              amount_due: 25000,
              currency: 'usd',
              customer_email: null,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/billing/failed-payments/bulk-email',
      payload: { ids: [INVOICE_ID] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sent).toBe(0);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].error).toContain('no billing_email');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
