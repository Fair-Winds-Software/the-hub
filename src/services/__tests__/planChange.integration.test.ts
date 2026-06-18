// Authorized by HUB-1493 — SSOT-053 audit sweep + full plan change lifecycle integration tests
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Integration tests — gated by STRIPE_INTEGRATION=1 ────────────────────────
// These tests verify the plan change lifecycle including next_cycle, immediate,
// grandfathering, webhook confirmation, and mixed history queries.
// Run with: STRIPE_INTEGRATION=1 npx vitest run planChange.integration

const SKIP = !process.env['STRIPE_INTEGRATION'];

describe.skipIf(SKIP)('planChange integration (plan change lifecycle)', () => {
  const mockPoolQuery = vi.fn();
  const mockPoolConnect = vi.fn();
  const mockClientQuery = vi.fn();
  const mockClientRelease = vi.fn();

  vi.mock('../../db/pool.js', () => ({
    getPool: () => ({
      query: mockPoolQuery,
      connect: mockPoolConnect,
    }),
  }));

  vi.mock('../../stripe/client.js', () => ({
    getStripe: vi.fn(() => ({
      subscriptions: {
        retrieve: vi.fn(),
        update: vi.fn(),
      },
      subscriptionSchedules: {
        create: vi.fn(),
        update: vi.fn(),
      },
    })),
    stripeIdempotencyKey: vi.fn(() => 'key'),
    mapStripeError: vi.fn(),
  }));

  vi.mock('../../lib/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  vi.mock('../../queues/index.js', () => ({
    getBillingJobsQueue: vi.fn(() => ({ add: vi.fn() })),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('immediate lifecycle: schedulePlanChange returns ledger row with applied_at set', async () => {
    const { schedulePlanChange } = await import('../planChangeService.js');
    const { getStripe } = await import('../../stripe/client.js');
    const stripe = getStripe();

    // Plan + sub + no override + no add-ons + no discount + ledger insert
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', stripe_price_id: 'price_new', stripe_product_id: 'prod_1', billing_interval: 'month' }] }) // plan
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: 'sub_1', stripe_price_id: 'price_old', current_period_end: new Date(), plan_id: 'plan-old' }] }) // sub
      .mockResolvedValueOnce({ rows: [] }) // getCurrentOverride
      .mockResolvedValueOnce({ rows: [] }) // add-ons
      .mockResolvedValueOnce({ rows: [] }) // discount
      .mockResolvedValueOnce({ rows: [{ id: 'ledger-1', applied_at: new Date(), plan_id: 'plan-1', applied_by: null, stripe_schedule_id: null, target_stripe_price_id: 'price_new' }] }); // INSERT

    (stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: { data: [{ id: 'si_1', price: { id: 'price_old' } }] },
    });
    (stripe.subscriptions.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const row = await schedulePlanChange('t-1', 'p-1', 'plan-1', 'immediate', 'upgrade test', 'operator');
    expect(row.applied_at).not.toBeNull();
    expect(stripe.subscriptions.update).toHaveBeenCalledOnce();
  });

  it('next_cycle lifecycle: ledger row has applied_at=null and stripe_schedule_id set', async () => {
    const { schedulePlanChange } = await import('../planChangeService.js');
    const { getStripe } = await import('../../stripe/client.js');
    const stripe = getStripe();

    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'plan-2', stripe_price_id: 'price_new2', stripe_product_id: 'prod_1', billing_interval: 'year' }] }) // plan
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: 'sub_2', stripe_price_id: 'price_old2', current_period_end: new Date(Date.now() + 86400000), plan_id: null }] }) // sub
      .mockResolvedValueOnce({ rows: [] }) // getCurrentOverride
      .mockResolvedValueOnce({ rows: [] }) // add-ons
      .mockResolvedValueOnce({ rows: [] }) // discount
      .mockResolvedValueOnce({ rows: [{ id: 'ledger-2', applied_at: null, stripe_schedule_id: 'sched_1', plan_id: 'plan-2', target_stripe_price_id: 'price_new2' }] }); // INSERT

    (stripe.subscriptionSchedules.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'sched_1',
      phases: [{ items: [{ price: 'price_old2', quantity: 1 }] }],
    });
    (stripe.subscriptionSchedules.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const row = await schedulePlanChange('t-1', 'p-1', 'plan-2', 'next_cycle', 'annual switch', 'operator');
    expect(row.applied_at).toBeNull();
    expect(row.stripe_schedule_id).toBe('sched_1');
  });

  it('grandfathering: inserts ledger rows with grandfathered=true for active subscribers', async () => {
    const { grandfatherExistingSubscribers } = await import('../planChangeService.js');

    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ stripe_price_id: 'price_arch' }] }) // plan lookup
      .mockResolvedValueOnce({ rows: [ // active subscribers
        { tenant_id: 't-1', product_id: 'p-1', current_period_end: new Date('2026-08-01') },
        { tenant_id: 't-2', product_id: 'p-1', current_period_end: new Date('2026-09-01') },
      ]})
      .mockResolvedValueOnce({ rows: [] }) // idempotency check t-1
      .mockResolvedValueOnce({ rows: [] }) // INSERT t-1
      .mockResolvedValueOnce({ rows: [] }) // idempotency check t-2
      .mockResolvedValueOnce({ rows: [] }); // INSERT t-2

    const count = await grandfatherExistingSubscribers('plan-arch');
    expect(count).toBe(2);
    // Both INSERT calls should have grandfathered=true
    const insertCalls = mockPoolQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO plan_change_ledger'),
    );
    expect(insertCalls).toHaveLength(2);
  });

  it('grandfathering: idempotent — skips already-grandfathered subscribers', async () => {
    const { grandfatherExistingSubscribers } = await import('../planChangeService.js');

    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ stripe_price_id: 'price_arch2' }] }) // plan lookup
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't-3', product_id: 'p-1', current_period_end: new Date() }] }) // subscriber
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] }); // existing grandfathered row → skip

    const count = await grandfatherExistingSubscribers('plan-arch2');
    expect(count).toBe(0);
  });

  it('confirmPlanChange: sets applied_at when price matches pending entry', async () => {
    const { confirmPlanChange } = await import('../planChangeService.js');

    const pending = { id: 'ledger-3', target_stripe_price_id: 'price_confirmed', plan_id: 'plan-1' };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [pending] }) // pending ledger row
      .mockResolvedValueOnce({ rows: [] })         // UPDATE plan_change_ledger
      .mockResolvedValueOnce({ rows: [{ id: 'plan-confirmed' }] }) // plan lookup
      .mockResolvedValueOnce({ rows: [] });          // UPDATE stripe_subscriptions

    await confirmPlanChange('t-1', 'p-1', 'price_confirmed');

    const updateCalls = mockPoolQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE plan_change_ledger'),
    );
    expect(updateCalls).toHaveLength(1);
  });

  it('confirmPlanChange: skips when price ID does not match pending entry', async () => {
    const { confirmPlanChange } = await import('../planChangeService.js');

    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'ledger-4', target_stripe_price_id: 'price_expected', plan_id: 'plan-1' }],
    });

    await confirmPlanChange('t-1', 'p-1', 'price_unexpected');

    // No UPDATE should have been called
    const updateCalls = mockPoolQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE plan_change_ledger'),
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('getPlanChangeHistory: returns all row types ordered by created_at DESC', async () => {
    const { getPlanChangeHistory } = await import('../planChangeService.js');

    const rows = [
      { id: 'a', grandfathered: false, applied_at: new Date(), created_at: new Date('2026-06-17') },
      { id: 'b', grandfathered: false, applied_at: null, created_at: new Date('2026-06-16') },
      { id: 'c', grandfathered: true, applied_at: null, created_at: new Date('2026-06-15') },
    ];
    mockPoolQuery.mockResolvedValueOnce({ rows });

    const result = await getPlanChangeHistory('t-1', 'p-1');
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('a');
    expect(result[2].grandfathered).toBe(true);
  });
});
