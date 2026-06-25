// Authorized by HUB-1589 (E-BE-1 S6, CR-2) — `isCreditMode` + zero-Stripe-call invariant
// for credit-mode subscriptions. Mocked Stripe SDK + mocked pool; we assert call counts
// on the SDK mocks to prove the bypass branch fires.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  isCreditMode,
  createSubscription,
  cancelSubscription,
  clearCreditModeCache,
} from '../stripeService.js';

beforeEach(() => {
  vi.clearAllMocks();
  clearCreditModeCache();
  mockGetStripe.mockReturnValue({
    customers: { create: mockCustomersCreate },
    subscriptions: {
      create: mockSubscriptionsCreate,
      update: mockSubscriptionsUpdate,
      cancel: mockSubscriptionsCancel,
    },
  });
  mockGetPlanById.mockResolvedValue({ id: 'plan-credit', stripe_price_id: 'price_credit', active: true });
});

describe('isCreditMode (HUB-1589)', () => {
  it('returns true when plans.billing_mode = credit', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ billing_mode: 'credit' }] });
    expect(await isCreditMode('plan-credit')).toBe(true);
  });

  it('returns false when plans.billing_mode = standard', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ billing_mode: 'standard' }] });
    expect(await isCreditMode('plan-standard')).toBe(false);
  });

  it('memoizes results — second call for the same planId hits cache', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ billing_mode: 'credit' }] });
    expect(await isCreditMode('plan-A')).toBe(true);
    expect(await isCreditMode('plan-A')).toBe(true);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('throws AppError(404) on unknown plan (fail-closed)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(isCreditMode('plan-missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('createSubscription credit-mode bypass (HUB-1589 CR-2 invariant)', () => {
  const CREDIT_SUB_RETURNING = {
    id: 'sub-row-credit-1',
    tenant_id: 'tenant-1',
    product_id: 'product-1',
    plan_id: 'plan-credit',
    stripe_subscription_id: 'internal:credit:00000000-0000-0000-0000-000000000001',
    stripe_price_id: 'internal:credit-price:plan-credit',
    status: 'active',
  };

  it('skips ensureStripeCustomer + stripe.subscriptions.create when billing_mode=credit', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ billing_mode: 'credit' }] }) // isCreditMode
      .mockResolvedValueOnce({ rows: [CREDIT_SUB_RETURNING] });      // INSERT stripe_subscriptions

    const row = await createSubscription('tenant-1', 'product-1', 'plan-credit', 'owner@example.com');

    // The invariant: zero Stripe SDK calls.
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(mockStripeIdempotencyKey).not.toHaveBeenCalled();

    // The synthetic ID prefix is present so downstream consumers detect credit-mode rows.
    expect(row.stripe_subscription_id).toMatch(/^internal:credit:/);
    expect(row.stripe_price_id).toMatch(/^internal:credit-price:/);
  });

  it('standard mode continues to make the Stripe call (control)', async () => {
    mockGetPlanById.mockResolvedValueOnce({ id: 'plan-standard', stripe_price_id: 'price_std', active: true });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ billing_mode: 'standard' }] })   // isCreditMode
      .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_x' }] }) // ensureStripeCustomer SELECT
      .mockResolvedValueOnce({ rows: [{ id: 'std-row' }] });              // INSERT stripe_subscriptions
    mockSubscriptionsCreate.mockResolvedValueOnce({
      id: 'sub_std',
      status: 'active',
      current_period_start: 1700000000,
      current_period_end: 1702678400,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_std' } }] },
      metadata: {},
    });
    mockStripeIdempotencyKey.mockReturnValue('idem');

    await createSubscription('tenant-1', 'product-1', 'plan-standard', 'owner@example.com');

    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
  });
});

describe('cancelSubscription credit-mode bypass (HUB-1589 CR-2 invariant)', () => {
  it('skips stripe.subscriptions.cancel when the row is internal:credit:* (immediate)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ stripe_subscription_id: 'internal:credit:abcd' }],
      })
      .mockResolvedValueOnce({ rows: [{ status: 'canceled' }] }); // local UPDATE

    await cancelSubscription('tenant-1', 'product-1', true);

    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockGetStripe).not.toHaveBeenCalled();
  });

  it('skips stripe.subscriptions.update when the row is internal:credit:* (period-end)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ stripe_subscription_id: 'internal:credit:abcd' }],
      })
      .mockResolvedValueOnce({ rows: [{ cancel_at_period_end: true }] }); // local UPDATE

    await cancelSubscription('tenant-1', 'product-1', false);

    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it('standard subscription continues to call stripe.subscriptions.cancel (control)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: 'sub_real_stripe' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'canceled' }] });
    mockSubscriptionsCancel.mockResolvedValueOnce({});

    await cancelSubscription('tenant-1', 'product-1', true);

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_real_stripe');
  });
});
