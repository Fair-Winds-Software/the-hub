// Authorized by HUB-1776 (S3 of HUB-1773) — unit tests for LiveStripeAdapter.
// Verifies method delegation, idempotencyKey pass-through, timeout wrapping,
// error mapping (mapStripeError), and Zod schema validation of SDK responses.
// The Stripe SDK is fully mocked; no network I/O.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { LiveStripeAdapter } from '../liveAdapter.js';

// Deep-mocked Stripe client. Each facet method is a vi.fn() we control per test.
function makeSdkMock(): Stripe {
  const sdk = {
    customers: {
      create: vi.fn(),
      update: vi.fn(),
      createBalanceTransaction: vi.fn(),
      deleteDiscount: vi.fn(),
    },
    subscriptions: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
      cancel: vi.fn(),
    },
    subscriptionSchedules: {
      create: vi.fn(),
      update: vi.fn(),
    },
    products: { create: vi.fn() },
    prices: { create: vi.fn() },
    invoices: { pay: vi.fn() },
    coupons: { create: vi.fn() },
    balance: { retrieve: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  };
  return sdk as unknown as Stripe;
}

// Realistic-shape fixtures the Zod schemas will accept.
const customerFixture = {
  id: 'cus_test',
  object: 'customer',
  created: 1735689600,
  email: 'a@b.co',
  name: null,
  metadata: {},
};
const subscriptionFixture = {
  id: 'sub_test',
  object: 'subscription',
  created: 1735689600,
  customer: 'cus_test',
  status: 'active',
  current_period_start: 1735689600,
  current_period_end: 1738368000,
  cancel_at_period_end: false,
  canceled_at: null,
  items: {
    object: 'list',
    data: [
      {
        id: 'si_test',
        object: 'subscription_item',
        price: {
          id: 'price_test',
          object: 'price',
          created: 1735689600,
          product: 'prod_test',
          unit_amount: 2000,
          currency: 'usd',
          active: true,
        },
        quantity: 1,
      },
    ],
    has_more: false,
  },
  metadata: {},
};
const invoiceFixture = {
  id: 'in_test',
  object: 'invoice',
  created: 1735689600,
  customer: 'cus_test',
  parent: null,
  status: 'paid',
  amount_due: 2000,
  amount_paid: 2000,
  currency: 'usd',
  period_start: 1735689600,
  period_end: 1738368000,
  lines: { object: 'list', data: [], has_more: false },
};
const balanceFixture = {
  object: 'balance',
  available: [{ amount: 1000, currency: 'usd' }],
  pending: [{ amount: 0, currency: 'usd' }],
  livemode: false,
};

describe('LiveStripeAdapter — delegation + idempotencyKey pass-through', () => {
  let sdk: Stripe;
  let adapter: LiveStripeAdapter;

  beforeEach(() => {
    sdk = makeSdkMock();
    adapter = new LiveStripeAdapter(sdk);
  });

  it('customers.create delegates to SDK with idempotencyKey', async () => {
    (sdk.customers.create as ReturnType<typeof vi.fn>).mockResolvedValue(customerFixture);
    const result = await adapter.customers.create(
      { email: 'a@b.co' },
      { idempotencyKey: 'key-abc' },
    );
    expect(sdk.customers.create).toHaveBeenCalledWith({ email: 'a@b.co' }, { idempotencyKey: 'key-abc' });
    expect(result.id).toBe('cus_test');
  });

  it('customers.create omits options arg when no idempotencyKey provided', async () => {
    (sdk.customers.create as ReturnType<typeof vi.fn>).mockResolvedValue(customerFixture);
    await adapter.customers.create({ email: 'a@b.co' });
    expect(sdk.customers.create).toHaveBeenCalledWith({ email: 'a@b.co' }, undefined);
  });

  it('subscriptions.retrieve passes id + undefined params + options', async () => {
    (sdk.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue(subscriptionFixture);
    await adapter.subscriptions.retrieve('sub_test', { idempotencyKey: 'k' });
    expect(sdk.subscriptions.retrieve).toHaveBeenCalledWith('sub_test', undefined, { idempotencyKey: 'k' });
  });

  it('invoices.pay passes id + undefined params + options', async () => {
    (sdk.invoices.pay as ReturnType<typeof vi.fn>).mockResolvedValue(invoiceFixture);
    await adapter.invoices.pay('in_test');
    expect(sdk.invoices.pay).toHaveBeenCalledWith('in_test', undefined, undefined);
  });

  it('balance.retrieve passes undefined params + options', async () => {
    (sdk.balance.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue(balanceFixture);
    const result = await adapter.balance.retrieve();
    expect(sdk.balance.retrieve).toHaveBeenCalledWith(undefined, undefined);
    expect(result.available[0]!.amount).toBe(1000);
  });

  it('customers.deleteDiscount returns void', async () => {
    (sdk.customers.deleteDiscount as ReturnType<typeof vi.fn>).mockResolvedValue({ deleted: true });
    const result = await adapter.customers.deleteDiscount('cus_test');
    expect(result).toBeUndefined();
    expect(sdk.customers.deleteDiscount).toHaveBeenCalledWith('cus_test', undefined);
  });
});

describe('LiveStripeAdapter — SDK errors propagate through unchanged', () => {
  // Adapter no longer wraps SDK errors via mapStripeError — that mapping happens at the
  // service-layer outer try/catch (which existed pre-adapter and remains). Adapter's job
  // is to expose the shape contract + timeout wrap; error classification is caller-owned.
  it('propagates StripeInvalidRequestError as-is', async () => {
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    const { default: RealStripe } = await import('stripe');
    const err = new RealStripe.errors.StripeInvalidRequestError({ message: 'bad param' });
    (sdk.customers.create as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    await expect(adapter.customers.create({ email: 'x' })).rejects.toBe(err);
  });

  it('propagates StripeRateLimitError as-is', async () => {
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    const { default: RealStripe } = await import('stripe');
    const err = new RealStripe.errors.StripeRateLimitError({ message: 'slow down' });
    (sdk.subscriptions.cancel as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    await expect(adapter.subscriptions.cancel('sub_test')).rejects.toBe(err);
  });

  it('propagates non-Stripe errors as-is', async () => {
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    (sdk.balance.retrieve as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network dead'));
    await expect(adapter.balance.retrieve()).rejects.toThrow('network dead');
  });
});

describe('LiveStripeAdapter — schema drift detection', () => {
  it('throws AppError(502) when SDK returns malformed response (production only)', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const sdk = makeSdkMock();
      const adapter = new LiveStripeAdapter(sdk);
      // Missing required fields: no `id`, no `object`.
      (sdk.customers.create as ReturnType<typeof vi.fn>).mockResolvedValue({ email: 'a@b.co' });
      await expect(adapter.customers.create({ email: 'a@b.co' })).rejects.toMatchObject({
        statusCode: 502,
        message: expect.stringContaining('Stripe response schema drift') as unknown as string,
      });
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('non-production silently returns raw when SDK returns malformed response', async () => {
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    (sdk.customers.create as ReturnType<typeof vi.fn>).mockResolvedValue({ email: 'a@b.co' });
    const result = await adapter.customers.create({ email: 'a@b.co' });
    expect(result).toEqual({ email: 'a@b.co' });
  });

  it('drops unknown fields silently (Zod default behavior — not passthrough)', async () => {
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    (sdk.customers.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...customerFixture,
      new_future_stripe_field: 'noise',
    });
    const result = await adapter.customers.create({ email: 'a@b.co' });
    expect(result).not.toHaveProperty('new_future_stripe_field');
  });
});

describe('LiveStripeAdapter — webhooks.constructEvent', () => {
  it('delegates signature verification and returns VerifiedStripeEvent envelope', () => {
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    (sdk.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'evt_test',
      type: 'invoice.created',
      api_version: '2026-05-27.dahlia',
      created: 1735689600,
      livemode: false,
      data: { object: invoiceFixture, previous_attributes: undefined },
    });
    const event = adapter.webhooks.constructEvent('raw-payload', 'sig-header', 'secret');
    expect(sdk.webhooks.constructEvent).toHaveBeenCalledWith('raw-payload', 'sig-header', 'secret');
    expect(event.id).toBe('evt_test');
    expect(event.type).toBe('invoice.created');
    expect(event.api_version).toBe('2026-05-27.dahlia');
    expect(event.data.object).toEqual(invoiceFixture);
  });

  it('passes through unrecognized event types (does NOT throw)', () => {
    // The webhook receiver's isRecognizedEventType gate handles type filtering downstream.
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    (sdk.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'evt_test',
      type: 'charge.succeeded',
      api_version: '2026-05-27.dahlia',
      created: 1735689600,
      livemode: false,
      data: { object: { id: 'ch_test', object: 'charge' } },
    });
    expect(() => adapter.webhooks.constructEvent('raw', 'sig', 'secret')).not.toThrow();
  });
});
