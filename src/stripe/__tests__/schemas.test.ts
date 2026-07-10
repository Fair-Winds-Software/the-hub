// Authorized by HUB-1775 (S2 of HUB-1773) — unit tests for the Zod schema contracts.
// Proves realistic Stripe fixtures parse cleanly, malformed inputs throw with a path,
// unknown fields are dropped (not passthrough), and the webhook discriminated union
// resolves the correct branch per event type.
import { describe, it, expect } from 'vitest';
import {
  BalanceSchema,
  CustomerSchema,
  ProductSchema,
  PriceSchema,
  CouponSchema,
  SubscriptionSchema,
  SubscriptionScheduleSchema,
  InvoiceSchema,
  BalanceTransactionSchema,
  StripeErrorShapeSchema,
  HubStripeEventSchema,
  paginationEnvelope,
} from '../schemas.js';

describe('BalanceSchema', () => {
  it('parses a realistic balance.retrieve() response', () => {
    const fixture = {
      object: 'balance',
      available: [{ amount: 12345, currency: 'usd' }],
      pending: [{ amount: 0, currency: 'usd' }],
      livemode: false,
    };
    expect(() => BalanceSchema.parse(fixture)).not.toThrow();
  });

  it('rejects uppercase currency (Stripe returns lowercase)', () => {
    expect(() =>
      BalanceSchema.parse({
        object: 'balance',
        available: [{ amount: 100, currency: 'USD' }],
        pending: [],
        livemode: false,
      }),
    ).toThrow();
  });
});

describe('CustomerSchema', () => {
  it('parses a customers.create response', () => {
    const fixture = {
      id: 'cus_test123',
      object: 'customer',
      created: 1735689600,
      email: 'test@example.com',
      name: null,
      metadata: { tenant_id: '00000000-0000-0000-0000-000000000000' },
    };
    const parsed = CustomerSchema.parse(fixture);
    expect(parsed.id).toBe('cus_test123');
    expect(parsed.email).toBe('test@example.com');
  });

  it('drops unknown fields (not passthrough)', () => {
    const parsed = CustomerSchema.parse({
      id: 'cus_test123',
      object: 'customer',
      created: 1735689600,
      email: 'a@b.co',
      new_stripe_field_we_dont_know_about: 'noise',
    });
    expect(parsed).not.toHaveProperty('new_stripe_field_we_dont_know_about');
  });

  it('rejects malformed email with clear path', () => {
    try {
      CustomerSchema.parse({
        id: 'cus_test123',
        object: 'customer',
        created: 1735689600,
        email: 'not-an-email',
      });
      throw new Error('Expected parse to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toContain('email');
    }
  });
});

describe('SubscriptionSchema', () => {
  it('parses a subscriptions.create response with items', () => {
    const fixture = {
      id: 'sub_test123',
      object: 'subscription',
      created: 1735689600,
      customer: 'cus_test123',
      status: 'active',
      current_period_start: 1735689600,
      current_period_end: 1738368000,
      cancel_at_period_end: false,
      canceled_at: null,
      items: {
        object: 'list',
        data: [
          {
            id: 'si_test123',
            object: 'subscription_item',
            price: {
              id: 'price_test123',
              object: 'price',
              created: 1735689600,
              product: 'prod_test',
              unit_amount: 2000,
              currency: 'usd',
              active: true,
              recurring: { interval: 'month', interval_count: 1 },
            },
            quantity: 1,
          },
        ],
        has_more: false,
      },
    };
    const parsed = SubscriptionSchema.parse(fixture);
    expect(parsed.status).toBe('active');
    expect(parsed.items.data[0]!.price.id).toBe('price_test123');
  });

  it('rejects unknown status value', () => {
    expect(() =>
      SubscriptionSchema.parse({
        id: 'sub_test',
        object: 'subscription',
        created: 1,
        customer: 'cus_test',
        status: 'nonsense',
        current_period_start: 1,
        current_period_end: 2,
        cancel_at_period_end: false,
        canceled_at: null,
        items: { object: 'list', data: [], has_more: false },
      }),
    ).toThrow();
  });
});

describe('SubscriptionScheduleSchema', () => {
  it('parses a subscriptionSchedules.create response', () => {
    const fixture = {
      id: 'sub_sched_test',
      object: 'subscription_schedule',
      created: 1735689600,
      customer: 'cus_test',
      subscription: 'sub_test',
      status: 'active',
      phases: [
        {
          start_date: 1735689600,
          end_date: 1738368000,
          items: [{ price: 'price_test', quantity: 1 }],
        },
      ],
      current_phase: { start_date: 1735689600, end_date: 1738368000 },
    };
    expect(() => SubscriptionScheduleSchema.parse(fixture)).not.toThrow();
  });
});

describe('InvoiceSchema', () => {
  it('parses a webhook invoice payload with parent as subscription_details', () => {
    const fixture = {
      id: 'in_test123',
      object: 'invoice',
      created: 1735689600,
      customer: 'cus_test',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_test' },
      },
      status: 'paid',
      amount_due: 2000,
      amount_paid: 2000,
      currency: 'usd',
      period_start: 1735689600,
      period_end: 1738368000,
      invoice_pdf: 'https://example.com/invoice.pdf',
      lines: {
        object: 'list',
        data: [
          {
            id: 'il_test',
            object: 'line_item',
            amount: 2000,
            currency: 'usd',
            description: 'test',
          },
        ],
        has_more: false,
      },
    };
    expect(() => InvoiceSchema.parse(fixture)).not.toThrow();
  });

  it('accepts null parent (invoice with no subscription)', () => {
    const fixture = {
      id: 'in_test123',
      object: 'invoice',
      created: 1735689600,
      customer: 'cus_test',
      parent: null,
      status: 'draft',
      amount_due: 500,
      amount_paid: 0,
      currency: 'usd',
      period_start: 1735689600,
      period_end: 1738368000,
      lines: { object: 'list', data: [], has_more: false },
    };
    expect(() => InvoiceSchema.parse(fixture)).not.toThrow();
  });
});

describe('BalanceTransactionSchema', () => {
  it('parses a customers.createBalanceTransaction response', () => {
    const fixture = {
      id: 'cbtxn_test',
      object: 'customer_balance_transaction',
      created: 1735689600,
      customer: 'cus_test',
      amount: -1000,
      currency: 'usd',
      description: 'credit adjustment',
    };
    expect(() => BalanceTransactionSchema.parse(fixture)).not.toThrow();
  });
});

describe('ProductSchema, PriceSchema, CouponSchema', () => {
  it('ProductSchema parses a products.create response', () => {
    expect(() =>
      ProductSchema.parse({
        id: 'prod_test',
        object: 'product',
        created: 1735689600,
        name: 'Test Product',
        active: true,
      }),
    ).not.toThrow();
  });

  it('PriceSchema parses a prices.create response with recurring', () => {
    expect(() =>
      PriceSchema.parse({
        id: 'price_test',
        object: 'price',
        created: 1735689600,
        product: 'prod_test',
        unit_amount: 2000,
        currency: 'usd',
        active: true,
        recurring: { interval: 'year', interval_count: 1 },
      }),
    ).not.toThrow();
  });

  it('CouponSchema parses a coupons.create response', () => {
    expect(() =>
      CouponSchema.parse({
        id: 'coup_test',
        object: 'coupon',
        created: 1735689600,
        name: '10% off',
        percent_off: 10,
        duration: 'once',
        valid: true,
      }),
    ).not.toThrow();
  });
});

describe('paginationEnvelope', () => {
  it('parses a Stripe list wrapper around any inner schema', () => {
    const envelope = paginationEnvelope(CustomerSchema);
    const fixture = {
      object: 'list',
      data: [
        { id: 'cus_1', object: 'customer', created: 1, email: 'a@b.co' },
        { id: 'cus_2', object: 'customer', created: 2, email: null },
      ],
      has_more: true,
      url: '/v1/customers',
    };
    const parsed = envelope.parse(fixture);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.has_more).toBe(true);
  });
});

describe('StripeErrorShapeSchema', () => {
  it('parses a well-formed error shape', () => {
    expect(() =>
      StripeErrorShapeSchema.parse({
        type: 'invalid_request_error',
        message: 'No such customer: cus_bad',
        code: 'resource_missing',
        param: 'customer',
        statusCode: 404,
      }),
    ).not.toThrow();
  });

  it('rejects unknown error type', () => {
    expect(() =>
      StripeErrorShapeSchema.parse({
        type: 'never_heard_of_it',
        message: 'x',
        statusCode: 500,
      }),
    ).toThrow();
  });
});

describe('HubStripeEventSchema (discriminated union)', () => {
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
    items: { object: 'list', data: [], has_more: false },
  };

  const invoiceFixture = {
    id: 'in_test',
    object: 'invoice',
    created: 1735689600,
    customer: 'cus_test',
    parent: null,
    status: 'paid',
    amount_due: 100,
    amount_paid: 100,
    currency: 'usd',
    period_start: 1,
    period_end: 2,
    lines: { object: 'list', data: [], has_more: false },
  };

  const makeEvent = (type: string, object: unknown) => ({
    id: 'evt_test',
    object: 'event',
    api_version: '2026-05-27.dahlia',
    created: 1735689600,
    type,
    data: { object },
    livemode: false,
  });

  it.each([
    ['customer.subscription.updated', subscriptionFixture],
    ['customer.subscription.deleted', subscriptionFixture],
    ['invoice.created', invoiceFixture],
    ['invoice.finalized', invoiceFixture],
    ['invoice.payment_succeeded', invoiceFixture],
    ['invoice.payment_failed', invoiceFixture],
  ])('accepts %s', (type, object) => {
    const parsed = HubStripeEventSchema.parse(makeEvent(type, object));
    expect(parsed.type).toBe(type);
  });

  it('rejects an event type HUB does not handle', () => {
    expect(() =>
      HubStripeEventSchema.parse(makeEvent('charge.succeeded', {})),
    ).toThrow();
  });

  it('rejects a subscription-typed event with an invoice-shaped payload', () => {
    expect(() =>
      HubStripeEventSchema.parse(
        makeEvent('customer.subscription.updated', invoiceFixture),
      ),
    ).toThrow();
  });
});
