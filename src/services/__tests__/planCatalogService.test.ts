// Authorized by HUB-1471 — planCatalogService test suite: buildStripePriceParams unit tests;
//   integration tests against Stripe test mode (STRIPE_INTEGRATION=1)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildStripePriceParams } from '../planCatalogService.js';
import type { PlanDef } from '../planCatalogService.js';

// ── buildStripePriceParams — pure function unit tests ─────────────────────────

const BASE_PRODUCT_ID = 'prod_test';
const BASE_DEF: PlanDef = {
  key: 'test-plan',
  name: 'Test Plan',
  billingType: 'flat_rate',
  billingInterval: 'month',
  unitAmountCents: 2700,
};

describe('buildStripePriceParams()', () => {
  describe('flat_rate', () => {
    it('monthly → per_unit, interval=month, interval_count=1, usage_type=licensed', () => {
      const params = buildStripePriceParams('flat_rate', 'month', BASE_DEF, BASE_PRODUCT_ID);
      expect(params.billing_scheme).toBe('per_unit');
      expect(params.unit_amount).toBe(2700);
      expect(params.recurring).toMatchObject({ interval: 'month', interval_count: 1, usage_type: 'licensed' });
    });

    it('quarterly → interval=month, interval_count=3', () => {
      const params = buildStripePriceParams('flat_rate', 'quarter', BASE_DEF, BASE_PRODUCT_ID);
      expect(params.recurring).toMatchObject({ interval: 'month', interval_count: 3 });
    });

    it('annual → interval=year, interval_count=1', () => {
      const params = buildStripePriceParams('flat_rate', 'year', BASE_DEF, BASE_PRODUCT_ID);
      expect(params.recurring).toMatchObject({ interval: 'year', interval_count: 1 });
    });
  });

  describe('per_seat', () => {
    it('produces per_unit with usage_type=licensed', () => {
      const params = buildStripePriceParams('per_seat', 'month', { ...BASE_DEF, billingType: 'per_seat' }, BASE_PRODUCT_ID);
      expect(params.billing_scheme).toBe('per_unit');
      expect(params.recurring).toMatchObject({ usage_type: 'licensed' });
    });
  });

  describe('metered', () => {
    it('produces per_unit with usage_type=metered', () => {
      const params = buildStripePriceParams('metered', 'month', { ...BASE_DEF, billingType: 'metered' }, BASE_PRODUCT_ID);
      expect(params.billing_scheme).toBe('per_unit');
      expect(params.recurring).toMatchObject({ usage_type: 'metered', interval: 'month' });
    });

    it('no unit_amount required for metered', () => {
      const def: PlanDef = { key: 'metered', name: 'Metered', billingType: 'metered', billingInterval: 'month' };
      const params = buildStripePriceParams('metered', 'month', def, BASE_PRODUCT_ID);
      expect(params.billing_scheme).toBe('per_unit');
    });
  });

  describe('tiered', () => {
    it('produces tiered with tiers_mode=graduated and tiers array', () => {
      const def: PlanDef = {
        key: 'tiered', name: 'Tiered', billingType: 'tiered', billingInterval: 'month',
        tiers: [{ upTo: 100, unitAmount: 50 }, { upTo: null, unitAmount: 30 }],
      };
      const params = buildStripePriceParams('tiered', 'month', def, BASE_PRODUCT_ID);
      expect(params.billing_scheme).toBe('tiered');
      expect(params.tiers_mode).toBe('graduated');
      expect(Array.isArray(params.tiers)).toBe(true);
      expect(params.tiers).toHaveLength(2);
      expect((params.tiers as Array<{ up_to: unknown }>)[1]?.up_to).toBe('inf');
    });
  });

  describe('one_time', () => {
    it('produces no recurring property', () => {
      const def: PlanDef = { key: 'one-time', name: 'One Time', billingType: 'one_time', unitAmountCents: 500000 };
      const params = buildStripePriceParams('one_time', undefined, def, BASE_PRODUCT_ID);
      expect(params.recurring).toBeUndefined();
      expect(params.unit_amount).toBe(500000);
    });
  });

  it('attaches the correct stripeProductId as product', () => {
    const params = buildStripePriceParams('flat_rate', 'month', BASE_DEF, 'prod_xyz');
    expect(params.product).toBe('prod_xyz');
  });

  it('currency is always usd', () => {
    const params = buildStripePriceParams('flat_rate', 'month', BASE_DEF, BASE_PRODUCT_ID);
    expect(params.currency).toBe('usd');
  });
});

// ── Integration tests — gated by STRIPE_INTEGRATION=1 ────────────────────────
// These tests call the real Stripe test mode API and require:
//   STRIPE_INTEGRATION=1 STRIPE_SECRET_KEY=sk_test_... DB connection to a seeded database

const SKIP = !process.env['STRIPE_INTEGRATION'];

describe.skipIf(SKIP)('planCatalogService integration (Stripe test mode)', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
  });

  it('createPlan flat_rate monthly: Stripe Price has billing_scheme=per_unit, interval=month', async () => {
    const { createPlan } = await import('../planCatalogService.js');
    const RUN_ID = Date.now();
    const PRODUCT_ID = 'prod-test-uuid';

    // Mock DB: no existing plan, product with no stripe_product_id, then cache, then insert
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] }) // idempotency check
      .mockResolvedValueOnce({ rows: [{ stripe_product_id: null, name: 'Test Product' }] }) // resolve product
      .mockResolvedValueOnce({ rows: [] }) // UPDATE products.stripe_product_id
      .mockResolvedValueOnce({ rows: [{ id: 'plan-uuid', stripe_price_id: 'price_test', active: false }] }); // INSERT plans

    const plan = await createPlan(PRODUCT_ID, {
      key: `flat-monthly-${RUN_ID}`,
      name: 'Flat Monthly',
      billingType: 'flat_rate',
      billingInterval: 'month',
      unitAmountCents: 2700,
    });

    expect(plan.stripe_price_id).toBe('price_test');
  });

  it('buildStripePriceParams idempotency: same key returns same plan', async () => {
    const { createPlan } = await import('../planCatalogService.js');
    const RUN_ID = Date.now();
    const existingPlan = { id: 'plan-existing', stripe_price_id: 'price_existing', active: true };

    mockPoolQuery.mockResolvedValueOnce({ rows: [existingPlan] }); // idempotency hit

    const plan = await createPlan('prod-uuid', { key: `dup-${RUN_ID}`, name: 'Dup', billingType: 'flat_rate' });

    expect(plan.id).toBe('plan-existing');
    expect(mockPoolQuery).toHaveBeenCalledTimes(1); // only idempotency SELECT, no Stripe call
  });

  it('archivePlan: sets active=false and inserts plan_archive_ledger row', async () => {
    const { archivePlan } = await import('../planCatalogService.js');
    const planId = 'plan-to-archive';

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: planId, active: true, stripe_price_id: 'price_old' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // UPDATE active=false
      .mockResolvedValueOnce({ rows: [] }) // INSERT plan_archive_ledger
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: planId, active: false, stripe_price_id: 'price_old' }] }); // re-fetch

    const updated = await archivePlan(planId, 'superseded', 'operator@example.com');

    expect(updated.active).toBe(false);
    const ledgerInsert = mockClientQuery.mock.calls[3]![0] as string;
    expect(ledgerInsert).toMatch(/plan_archive_ledger/);
  });

  it('archivePlan: throws AppError(409) when plan already archived', async () => {
    const { archivePlan } = await import('../planCatalogService.js');
    const { AppError } = await import('../../errors/AppError.js');

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'plan-1', active: false, stripe_price_id: 'price_1' }] }); // already inactive

    await expect(archivePlan('plan-1')).rejects.toMatchObject({ statusCode: 409 });
    expect(mockClientRelease).toHaveBeenCalled();
  });
});
