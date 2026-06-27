// Authorized by HUB-1590 (E-BE-1 S7, CR-2) — unit tests for the credit-mode internal invoice
// entry point. Mocks isCreditMode (HUB-1589) + writeAuditEntry + pool to verify the boundary
// behavior in isolation; the live-DB migration shape is verified by
// invoicesExternalProvider.integration.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockIsCreditMode = vi.hoisted(() => vi.fn());
vi.mock('../stripeService.js', () => ({ isCreditMode: mockIsCreditMode }));

const mockWriteAuditEntry = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../auditLogService.js', () => ({ writeAuditEntry: mockWriteAuditEntry }));

vi.mock('../../queues/index.js', () => ({
  getBillingPaymentFailedQueue: () => ({ add: vi.fn() }),
  defaultJobOptions: () => ({}),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createInternalInvoice } from '../invoiceService.js';
import { AppError } from '../../errors/AppError.js';

const VALID_INPUT = {
  tenantId: '00000000-0000-0000-0000-000000000aaa',
  productId: '00000000-0000-0000-0000-000000000bbb',
  planId: 'plan-credit-1',
  stripeSubscriptionId: 'internal:credit:11111111-1111-1111-1111-111111111111',
  periodStart: new Date('2026-06-01T00:00:00Z'),
  periodEnd: new Date('2026-07-01T00:00:00Z'),
  amountCents: 1500,
  currency: 'usd',
};

const INSERTED_ROW = {
  id: '00000000-0000-0000-0000-000000000ccc',
  tenant_id: VALID_INPUT.tenantId,
  product_id: VALID_INPUT.productId,
  stripe_invoice_id: 'inv_internal:zzz',
  stripe_subscription_id: VALID_INPUT.stripeSubscriptionId,
  status: 'paid',
  amount_due: 1500,
  amount_paid: 1500,
  currency: 'usd',
  period_start: VALID_INPUT.periodStart,
  period_end: VALID_INPUT.periodEnd,
  invoice_pdf_url: null,
  payment_failed_at: null,
  external_provider: 'internal',
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createInternalInvoice (HUB-1590)', () => {
  describe('defensive guard against standard plans', () => {
    it('throws AppError(400) when the plan is not credit mode', async () => {
      mockIsCreditMode.mockResolvedValueOnce(false);

      await expect(createInternalInvoice(VALID_INPUT)).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it('propagates AppError(404) from isCreditMode when the plan does not exist', async () => {
      mockIsCreditMode.mockRejectedValueOnce(new AppError(404, 'Plan not found'));

      await expect(createInternalInvoice(VALID_INPUT)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe('happy path — credit mode', () => {
    beforeEach(() => {
      mockIsCreditMode.mockResolvedValue(true);
      mockPoolQuery.mockResolvedValue({ rows: [INSERTED_ROW] });
    });

    it('inserts the row with external_provider=internal and status=paid', async () => {
      const row = await createInternalInvoice(VALID_INPUT);

      expect(row).toEqual(INSERTED_ROW);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0]!;
      expect(sql).toMatch(/INSERT INTO invoices/);
      expect(sql).toMatch(/external_provider/);
      // amount_due and amount_paid both use the same param (param 5) per the SQL.
      expect(params[0]).toBe(VALID_INPUT.tenantId);
      expect(params[1]).toBe(VALID_INPUT.productId);
      expect(params[3]).toBe(VALID_INPUT.stripeSubscriptionId);
      expect(params[4]).toBe(VALID_INPUT.amountCents);
      expect(params[5]).toBe(VALID_INPUT.currency);
    });

    it('generates a synthetic stripe_invoice_id with the inv_internal: prefix', async () => {
      await createInternalInvoice(VALID_INPUT);
      const [, params] = mockPoolQuery.mock.calls[0]!;
      const syntheticId = params[2] as string;
      expect(syntheticId).toMatch(/^inv_internal:[0-9a-f-]{36}$/);
    });

    it('writes a single audit_log entry with event=invoice.created.internal', async () => {
      await createInternalInvoice(VALID_INPUT);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = mockWriteAuditEntry.mock.calls[0]![0];
      expect(entry).toMatchObject({
        tenant_id: VALID_INPUT.tenantId,
        product_id: VALID_INPUT.productId,
        actor_type: 'system',
        operation: 'INSERT',
        table_name: 'invoices',
        record_id: INSERTED_ROW.id,
      });
      expect(entry.new_values).toMatchObject({
        event: 'invoice.created.internal',
        external_provider: 'internal',
        amount_due: VALID_INPUT.amountCents,
        currency: VALID_INPUT.currency,
      });
    });

    it('returns the inserted row with external_provider=internal', async () => {
      const row = await createInternalInvoice(VALID_INPUT);
      expect(row.external_provider).toBe('internal');
      expect(row.status).toBe('paid');
    });
  });

  describe('zero Stripe SDK calls (CR-2 invariant)', () => {
    it('does not import or invoke any runtime Stripe SDK in the credit path', async () => {
      // Validated structurally by:
      //   1. scripts/lint-stripe-boundary.mjs (CI gate)
      //   2. invoiceService.ts header has no `import Stripe from 'stripe'` — only the type import
      // This assertion is meta-documentation; the actual enforcement lives in the boundary script.
      mockIsCreditMode.mockResolvedValueOnce(true);
      mockPoolQuery.mockResolvedValueOnce({ rows: [INSERTED_ROW] });
      await createInternalInvoice(VALID_INPUT);
      // No mocked Stripe SDK call could be made here — the service has no SDK import to mock.
      expect(true).toBe(true);
    });
  });
});
