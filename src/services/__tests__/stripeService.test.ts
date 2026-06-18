// Authorized by HUB-426 — unit tests: ensureStripeCustomer
// Authorized by HUB-427 — unit tests: createSubscription, cancelSubscription, getSubscriptions
// Authorized by HUB-428 — unit tests: handleSubscriptionUpdated, handleSubscriptionDeleted
// Authorized by HUB-503 — unit tests: cancelSubscription immediate path
// Authorized by HUB-1470 — unit tests updated: createSubscription accepts planId; mocks getPlanById
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const mockCustomersCreate = vi.hoisted(() => vi.fn());
const mockSubscriptionsCreate = vi.hoisted(() => vi.fn());
const mockSubscriptionsUpdate = vi.hoisted(() => vi.fn());
const mockSubscriptionsCancel = vi.hoisted(() => vi.fn());
const mockGetStripe = vi.hoisted(() => vi.fn());
const mockStripeIdempotencyKey = vi.hoisted(() => vi.fn());
const mockMapStripeError = vi.hoisted(() => vi.fn());

vi.mock('../../stripe/client.js', () => ({
  getStripe: mockGetStripe,
  stripeIdempotencyKey: mockStripeIdempotencyKey,
  mapStripeError: mockMapStripeError,
}));

const mockGetPlanById = vi.hoisted(() => vi.fn());
vi.mock('../planCatalogService.js', () => ({ getPlanById: mockGetPlanById }));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ensureStripeCustomer,
  createSubscription,
  cancelSubscription,
  getSubscriptions,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
} from '../stripeService.js';
import { AppError } from '../../errors/AppError.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockStripeIdempotencyKey.mockReturnValue('idempotency-key');
  mockGetStripe.mockReturnValue({
    customers: { create: mockCustomersCreate },
    subscriptions: { create: mockSubscriptionsCreate, update: mockSubscriptionsUpdate, cancel: mockSubscriptionsCancel },
  });
  mockGetPlanById.mockResolvedValue({ id: 'plan-1', stripe_price_id: 'price_1', active: true });
});

// ── ensureStripeCustomer ──────────────────────────────────────────────────────

describe('ensureStripeCustomer()', () => {
  it('returns existing stripe_customer_id without calling Stripe', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_existing' }] });

    const result = await ensureStripeCustomer('tenant-1', 'owner@example.com');

    expect(result).toBe('cus_existing');
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  it('creates a Stripe customer and upserts when no row exists', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT stripe_customer_id
      .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_new' }] }); // INSERT UPSERT
    mockCustomersCreate.mockResolvedValueOnce({ id: 'cus_new' });

    const result = await ensureStripeCustomer('tenant-1', 'owner@example.com');

    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'owner@example.com' }),
      expect.any(Object),
    );
    expect(result).toBe('cus_new');
  });

  it('calls mapStripeError when Stripe.customers.create throws', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const stripeErr = new Error('stripe down');
    mockCustomersCreate.mockRejectedValueOnce(stripeErr);
    mockMapStripeError.mockImplementationOnce(() => { throw new AppError(502, 'stripe down'); });

    await expect(ensureStripeCustomer('tenant-1', 'owner@example.com')).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(mockMapStripeError).toHaveBeenCalledWith(stripeErr);
  });
});

// ── createSubscription ────────────────────────────────────────────────────────

describe('createSubscription()', () => {
  const mockSub = {
    id: 'sub_1',
    status: 'active',
    current_period_start: 1700000000,
    current_period_end: 1702678400,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_1' } }] },
    metadata: { tenant_id: 'tenant-1', product_id: 'product-1' },
  };
  const subRow = { id: 'row-1', stripe_subscription_id: 'sub_1' };

  describe('happy path', () => {
    beforeEach(() => {
      // ensureStripeCustomer: SELECT returns existing customer
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_1' }] });
      // INSERT UPSERT for stripe_subscriptions
      mockPoolQuery.mockResolvedValueOnce({ rows: [subRow] });
      mockSubscriptionsCreate.mockResolvedValueOnce(mockSub);
    });

    it('resolves planId via getPlanById and returns the upserted subscription row', async () => {
      const result = await createSubscription('tenant-1', 'product-1', 'plan-1', 'owner@example.com');
      expect(mockGetPlanById).toHaveBeenCalledWith('plan-1');
      expect(result).toEqual(subRow);
    });

    it('calls Stripe subscriptions.create with the resolved stripe_price_id', async () => {
      await createSubscription('tenant-1', 'product-1', 'plan-1', 'owner@example.com');
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_1',
          items: expect.arrayContaining([expect.objectContaining({ price: 'price_1' })]),
        }),
        expect.any(Object),
      );
    });
  });

  describe('plan validation errors', () => {
    it('throws AppError(400) when plan is archived', async () => {
      mockGetPlanById.mockResolvedValueOnce({ id: 'plan-1', stripe_price_id: 'price_1', active: false });
      await expect(createSubscription('tenant-1', 'product-1', 'plan-1', 'owner@example.com')).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    });

    it('propagates AppError(404) when plan not found', async () => {
      mockGetPlanById.mockRejectedValueOnce(new AppError(404, 'Plan not found'));
      await expect(createSubscription('tenant-1', 'product-1', 'plan-missing', 'owner@example.com')).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });
});

// ── cancelSubscription ────────────────────────────────────────────────────────

describe('cancelSubscription()', () => {
  it('throws AppError(404) when subscription not found', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(cancelSubscription('tenant-1', 'product-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('updates cancel_at_period_end in Stripe and DB on success', async () => {
    const subRow = { id: 'row-1', cancel_at_period_end: true };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: 'sub_1' }] })
      .mockResolvedValueOnce({ rows: [subRow] });
    mockSubscriptionsUpdate.mockResolvedValueOnce({});

    const result = await cancelSubscription('tenant-1', 'product-1');

    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    expect(result).toEqual(subRow);
  });

  it('immediate=true calls stripe.subscriptions.cancel and sets status=canceled', async () => {
    const subRow = { id: 'row-1', status: 'canceled', cancelled_at: new Date() };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: 'sub_1' }] })
      .mockResolvedValueOnce({ rows: [subRow] });
    mockSubscriptionsCancel.mockResolvedValueOnce({});

    const result = await cancelSubscription('tenant-1', 'product-1', true);

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_1');
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockPoolQuery.mock.calls[1]![0]).toMatch(/status = 'canceled'/);
    expect(result).toEqual(subRow);
  });
});

// ── getSubscriptions ──────────────────────────────────────────────────────────

describe('getSubscriptions()', () => {
  it('returns rows ordered by created_at DESC', async () => {
    const rows = [{ id: 'row-1' }, { id: 'row-2' }];
    mockPoolQuery.mockResolvedValueOnce({ rows });

    const result = await getSubscriptions('tenant-1');

    expect(result).toEqual(rows);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY created_at DESC'),
      ['tenant-1'],
    );
  });

  it('returns empty array when no subscriptions exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getSubscriptions('tenant-1')).toEqual([]);
  });
});

// ── handleSubscriptionUpdated ─────────────────────────────────────────────────

describe('handleSubscriptionUpdated()', () => {
  const makeRawEvent = (overrides = {}) =>
    JSON.stringify({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          current_period_start: 1700000000,
          current_period_end: 1702678400,
          cancel_at_period_end: false,
          canceled_at: null,
          items: { data: [{ price: { id: 'price_1' } }] },
          metadata: { tenant_id: 'tenant-1', product_id: 'product-1', ...overrides },
        },
      },
    });

  it('upserts stripe_subscriptions when event is found', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeRawEvent() }] })
      .mockResolvedValueOnce({ rows: [] }); // upsert

    await handleSubscriptionUpdated('evt_1');

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    expect(mockPoolQuery.mock.calls[1]![0]).toMatch(/ON CONFLICT/);
  });

  it('logs warn and returns early when event not in DB', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await handleSubscriptionUpdated('missing-evt');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('skips upsert when metadata is missing tenant_id', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ raw_event: makeRawEvent({ tenant_id: '' }) }],
    });
    await handleSubscriptionUpdated('evt_1');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

// ── handleSubscriptionDeleted ─────────────────────────────────────────────────

describe('handleSubscriptionDeleted()', () => {
  const makeRawEvent = () =>
    JSON.stringify({
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_1',
          metadata: { tenant_id: 'tenant-1', product_id: 'product-1' },
        },
      },
    });

  it('sets status=canceled and cancelled_at=NOW() for the subscription', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ raw_event: makeRawEvent() }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    await handleSubscriptionDeleted('evt_2');

    expect(mockPoolQuery.mock.calls[1]![0]).toMatch(/status = 'canceled'/);
    expect(mockPoolQuery.mock.calls[1]![1]).toContain('sub_1');
  });

  it('logs warn and returns early when event not in DB', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await handleSubscriptionDeleted('missing-evt');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});
