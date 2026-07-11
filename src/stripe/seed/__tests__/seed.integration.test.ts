// Authorized by HUB-1778 (S5 of HUB-1773) — integration tests for the programmatic seeding
// API. Runs against real stripe_mock.* tables. Verifies typed inputs, relational integrity,
// bulk transactional semantics, mock-only guard delegation, reset + snapshot.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seed } from '../index.js';
import { _resetStripeRegistryForTest, _setStripeModeForTest } from '../../registry.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

(RUN_INTEGRATION ? describe : describe.skip)(
  'Seeding API (RUN_INTEGRATION=1)',
  () => {
    beforeAll(() => {
      _setStripeModeForTest('mock');
    });

    afterAll(async () => {
      await seed.reset();
      _resetStripeRegistryForTest();
      const { closePool } = await import('../../../db/pool.js');
      await closePool();
    });

    beforeEach(async () => {
      await seed.reset();
    });

    describe('customers.create', () => {
      it('creates a single customer and auto-generates a cus_* id', async () => {
        const [result] = await seed.customers.create({ email: 'a@b.co' });
        expect(result!.id).toMatch(/^cus_[0-9a-f]{24}$/);
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(1);
      });

      it('creates a batch of customers in a single transaction', async () => {
        const results = await seed.customers.create([
          { email: 'a@b.co' },
          { email: 'c@d.co' },
          { email: 'e@f.co' },
        ]);
        expect(results).toHaveLength(3);
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(3);
      });

      it('accepts explicit id and preserves it', async () => {
        const [result] = await seed.customers.create({ id: 'cus_fixed', email: 'a@b.co' });
        expect(result!.id).toBe('cus_fixed');
      });

      it('rejects malformed batch with per-index error report', async () => {
        await expect(
          seed.customers.create([
            { email: 'a@b.co' },
            { email: 'not-an-email' } as unknown as { email: string },
          ]),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('index(es): 1') as unknown as string,
        });
        // All-or-nothing: the good row also gets rolled back.
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(0);
      });
    });

    describe('subscriptions.create — FK enforcement', () => {
      it('rejects orphaned customer reference before any INSERT', async () => {
        const [product] = await seed.products.create({ name: 'p' });
        const [price] = await seed.prices.create({
          product: product!.id, unit_amount: 1000, currency: 'usd',
        });
        await expect(
          seed.subscriptions.create({
            customer: 'cus_does_not_exist',
            items: [{ price: price!.id }],
          }),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('Orphaned customer reference') as unknown as string,
        });
      });

      it('rejects orphaned price reference before any INSERT', async () => {
        const [customer] = await seed.customers.create({ email: 'a@b.co' });
        await expect(
          seed.subscriptions.create({
            customer: customer!.id,
            items: [{ price: 'price_does_not_exist' }],
          }),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('Orphaned price reference') as unknown as string,
        });
      });

      it('creates a subscription with valid customer + price refs', async () => {
        const [product] = await seed.products.create({ name: 'p' });
        const [price] = await seed.prices.create({
          product: product!.id, unit_amount: 1000, currency: 'usd',
          recurring_interval: 'month', recurring_interval_count: 1,
        });
        const [customer] = await seed.customers.create({ email: 'a@b.co' });
        const [sub] = await seed.subscriptions.create({
          customer: customer!.id,
          items: [{ price: price!.id, quantity: 2 }],
        });
        expect(sub!.id).toMatch(/^sub_[0-9a-f]{24}$/);
        const snap = await seed.snapshot();
        expect(snap.subscriptions).toBe(1);
      });
    });

    describe('invoices.create — FK enforcement', () => {
      it('rejects orphaned subscription reference', async () => {
        const [customer] = await seed.customers.create({ email: 'a@b.co' });
        await expect(
          seed.invoices.create({
            customer: customer!.id,
            subscription: 'sub_does_not_exist',
            amount_due: 1000,
            currency: 'usd',
          }),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('Orphaned subscription reference') as unknown as string,
        });
      });

      it('creates an invoice with null parent when no subscription', async () => {
        const [customer] = await seed.customers.create({ email: 'a@b.co' });
        const [invoice] = await seed.invoices.create({
          customer: customer!.id,
          amount_due: 500,
          currency: 'usd',
        });
        expect(invoice!.id).toMatch(/^in_[0-9a-f]{24}$/);
      });
    });

    describe('mock-only guard', () => {
      it('throws when called with mode=live', async () => {
        _setStripeModeForTest('live');
        try {
          await expect(seed.customers.create({ email: 'a@b.co' })).rejects.toMatchObject({
            statusCode: 400,
            message: expect.stringContaining('Seeding forbidden') as unknown as string,
          });
        } finally {
          _setStripeModeForTest('mock');
        }
      });
    });

    describe('reset + snapshot', () => {
      it('reset truncates every stripe_mock.* table', async () => {
        const [product] = await seed.products.create({ name: 'x' });
        await seed.prices.create({
          product: product!.id, unit_amount: 100, currency: 'usd',
        });
        await seed.customers.create([{ email: 'a@b.co' }, { email: 'c@d.co' }]);
        let snap = await seed.snapshot();
        expect(snap.customers).toBe(2);
        expect(snap.products).toBe(1);
        expect(snap.prices).toBe(1);

        await seed.reset();
        snap = await seed.snapshot();
        expect(snap.customers).toBe(0);
        expect(snap.products).toBe(0);
        expect(snap.prices).toBe(0);
      });
    });

    describe('performance — bulk seed of 500 customers + subs + invoices', () => {
      it('completes in <10s and all rows validate', async () => {
        const [product] = await seed.products.create({ name: 'perf' });
        const [monthlyPrice] = await seed.prices.create({
          product: product!.id, unit_amount: 2000, currency: 'usd',
          recurring_interval: 'month', recurring_interval_count: 1,
        });

        const start = Date.now();
        const customers = await seed.customers.create(
          Array.from({ length: 500 }, (_, i) => ({ email: `perf-${i}@integration.test` })),
        );
        const statuses: Array<'active' | 'past_due' | 'canceled'> = ['active', 'past_due', 'canceled'];
        await seed.subscriptions.create(
          customers.map((c, i) => ({
            customer: c.id,
            status: statuses[i % 3]!,
            items: [{ price: monthlyPrice!.id }],
          })),
        );
        const durationMs = Date.now() - start;
        expect(durationMs).toBeLessThan(10_000);
        const snap = await seed.snapshot();
        expect(snap.customers).toBe(500);
        expect(snap.subscriptions).toBe(500);
      });
    });
  },
);
