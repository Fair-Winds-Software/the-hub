// Authorized by HUB-489 — unit tests: invoiceService; getInvoices, handleInvoiceCreated,
//   handleInvoiceFinalized, handleInvoicePaymentSucceeded, handleInvoicePaymentFailed
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockQueueAdd = vi.hoisted(() => vi.fn());
const mockGetBillingPaymentFailedQueue = vi.hoisted(() => vi.fn());
const mockDefaultJobOptions = vi.hoisted(() => vi.fn());
vi.mock('../../queues/index.js', () => ({
  getBillingPaymentFailedQueue: mockGetBillingPaymentFailedQueue,
  defaultJobOptions: mockDefaultJobOptions,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getInvoices,
  handleInvoiceCreated,
  handleInvoiceFinalized,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
} from '../invoiceService.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBillingPaymentFailedQueue.mockReturnValue({ add: mockQueueAdd });
  mockDefaultJobOptions.mockReturnValue({ attempts: 5 });
});

// ── getInvoices ───────────────────────────────────────────────────────────────

describe('getInvoices()', () => {
  it('returns rows ordered by period_start DESC', async () => {
    const rows = [{ id: 'inv-1' }, { id: 'inv-2' }];
    mockPoolQuery.mockResolvedValueOnce({ rows });

    const result = await getInvoices('tenant-1');

    expect(result).toEqual(rows);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY period_start DESC'),
      expect.arrayContaining(['tenant-1']),
    );
  });

  it('applies productId filter when provided', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await getInvoices('tenant-1', 'product-1');

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('product_id'),
      expect.arrayContaining(['tenant-1', 'product-1']),
    );
  });

  it('caps limit at MAX_LIMIT (100)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await getInvoices('tenant-1', undefined, 999);

    const args = mockPoolQuery.mock.calls[0]![1] as unknown[];
    expect(args).toContain(100);
  });

  it('returns empty array when no invoices exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getInvoices('tenant-1')).toEqual([]);
  });
});

// ── handleInvoiceCreated ──────────────────────────────────────────────────────

const makeInvoiceEvent = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_1',
    type: 'invoice.created',
    data: {
      object: {
        id: 'in_1',
        status: 'draft',
        amount_due: 5000,
        amount_paid: 0,
        currency: 'usd',
        period_start: 1700000000,
        period_end: 1702678400,
        invoice_pdf: null,
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: 'sub_1', metadata: null },
          quote_details: null,
        },
        lines: { data: [{ id: 'li_1', amount: 5000, description: 'Plan', quantity: 1, pricing: { type: 'price_details', price_details: { price: 'price_1', product: 'prod_1' }, unit_amount_decimal: null } }] },
        ...overrides,
      },
    },
  });

describe('handleInvoiceCreated()', () => {
  it('logs warn and returns when event not found in DB', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await handleInvoiceCreated('missing-evt');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('logs warn and returns when invoice has no subscription', async () => {
    const event = JSON.stringify({
      id: 'evt_2',
      type: 'invoice.created',
      data: { object: { id: 'in_2', parent: null, lines: { data: [] } } },
    });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ raw_event: event }] });
    await handleInvoiceCreated('evt_2');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('throws AppError(404) when stripe_subscriptions row not found — triggers retry', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeInvoiceEvent() }] })
      .mockResolvedValueOnce({ rows: [] }); // stripe_subscriptions lookup

    await expect(handleInvoiceCreated('evt_1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('upserts invoice and line items on success', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeInvoiceEvent() }] }) // raw_event
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', product_id: 'product-1' }] }) // sub lookup
      .mockResolvedValueOnce({ rows: [{ id: 'db-inv-1' }] }) // invoice upsert RETURNING id
      .mockResolvedValueOnce({ rows: [] }); // invoice_items insert

    await handleInvoiceCreated('evt_1');

    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
    expect(mockPoolQuery.mock.calls[2]![0]).toMatch(/ON CONFLICT \(stripe_invoice_id\)/);
    expect(mockPoolQuery.mock.calls[3]![0]).toMatch(/ON CONFLICT \(stripe_invoice_item_id\)/);
  });

  it('resolves subscription from parent.subscription_details.subscription string', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeInvoiceEvent() }] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't', product_id: 'p' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'db-inv-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handleInvoiceCreated('evt_1');

    expect(mockPoolQuery.mock.calls[1]![1]).toContain('sub_1');
  });
});

// ── handleInvoiceFinalized ────────────────────────────────────────────────────

describe('handleInvoiceFinalized()', () => {
  const makeEvent = (pdf: string | null = 'https://invoice.pdf') =>
    JSON.stringify({
      id: 'evt_3',
      type: 'invoice.finalized',
      data: { object: { id: 'in_1', invoice_pdf: pdf } },
    });

  it('logs warn and returns when event not found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await handleInvoiceFinalized('missing-evt');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("updates status='open' and invoice_pdf_url", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeEvent() }] })
      .mockResolvedValueOnce({ rows: [] });

    await handleInvoiceFinalized('evt_3');

    expect(mockPoolQuery.mock.calls[1]![0]).toMatch(/status = 'open'/);
    expect(mockPoolQuery.mock.calls[1]![1]).toContain('in_1');
    expect(mockPoolQuery.mock.calls[1]![1]).toContain('https://invoice.pdf');
  });

  it('handles null invoice_pdf', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeEvent(null) }] })
      .mockResolvedValueOnce({ rows: [] });

    await handleInvoiceFinalized('evt_3');

    expect(mockPoolQuery.mock.calls[1]![1]).toContain(null);
  });
});

// ── handleInvoicePaymentSucceeded ─────────────────────────────────────────────

describe('handleInvoicePaymentSucceeded()', () => {
  const makeEvent = () =>
    JSON.stringify({
      id: 'evt_4',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_1', amount_paid: 5000 } },
    });

  it('logs warn and returns when event not found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await handleInvoicePaymentSucceeded('missing-evt');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("updates status='paid', amount_paid, clears payment_failed_at", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeEvent() }] })
      .mockResolvedValueOnce({ rows: [] });

    await handleInvoicePaymentSucceeded('evt_4');

    const query = mockPoolQuery.mock.calls[1]![0] as string;
    expect(query).toMatch(/status = 'paid'/);
    expect(query).toMatch(/payment_failed_at = NULL/);
    expect(mockPoolQuery.mock.calls[1]![1]).toContain(5000);
  });
});

// ── handleInvoicePaymentFailed ────────────────────────────────────────────────

describe('handleInvoicePaymentFailed()', () => {
  const makeEvent = () =>
    JSON.stringify({
      id: 'evt_5',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1' } },
    });

  it('logs warn and returns when event not found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await handleInvoicePaymentFailed('missing-evt');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("updates status='payment_failed' and payment_failed_at=NOW()", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeEvent() }] })
      .mockResolvedValueOnce({ rows: [] });
    mockQueueAdd.mockResolvedValueOnce({});

    await handleInvoicePaymentFailed('evt_5');

    const query = mockPoolQuery.mock.calls[1]![0] as string;
    expect(query).toMatch(/status = 'payment_failed'/);
    expect(query).toMatch(/payment_failed_at = NOW\(\)/);
  });

  it('enqueues billing_payment_failed job with dedup jobId', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeEvent() }] })
      .mockResolvedValueOnce({ rows: [] });
    mockQueueAdd.mockResolvedValueOnce({});

    await handleInvoicePaymentFailed('evt_5');

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'billing_payment_failed',
      expect.objectContaining({ stripe_invoice_id: 'in_1' }),
      expect.objectContaining({ jobId: 'billing_payment_failed:in_1' }),
    );
  });
});
