// Authorized by HUB-1777 (S4 of HUB-1773) — integration tests for MockStripeAdapter.
// Runs against real stripe_mock.* tables. Verifies:
//   - end-to-end product → price → customer → subscription → invoice flow
//   - referential integrity enforced at the adapter boundary (invalid ref → 400)
//   - idempotencyKey pass-through: repeat calls return the original response verbatim
//   - setNextError injects failure paths for adversarial tests
//   - webhook events written to stripe_mock.events on mutations + forwarded to injected emitter
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockStripeAdapter, type MockWebhookEmitter } from '../mockAdapter.js';
import type { VerifiedStripeEvent } from '../connection.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const RUN_TAG = Date.now().toString();

(RUN_INTEGRATION ? describe : describe.skip)(
  'MockStripeAdapter integration (RUN_INTEGRATION=1)',
  () => {
    let adapter: MockStripeAdapter;
    const createdCustomers: string[] = [];
    const createdProducts: string[] = [];

    beforeAll(() => {
      adapter = new MockStripeAdapter();
    });

    afterAll(async () => {
      const { getPool } = await import('../../db/pool.js');
      const pool = getPool();
      if (createdCustomers.length > 0) {
        await pool.query('DELETE FROM stripe_mock.customers WHERE id = ANY($1)', [createdCustomers]);
      }
      if (createdProducts.length > 0) {
        await pool.query('DELETE FROM stripe_mock.products WHERE id = ANY($1)', [createdProducts]);
      }
      const { closePool } = await import('../../db/pool.js');
      await closePool();
    });

    describe('end-to-end flow', () => {
      it('creates a full product → price → customer → subscription chain', async () => {
        const product = await adapter.products.create({ name: `Test Product ${RUN_TAG}` });
        createdProducts.push(product.id);
        expect(product.id).toMatch(/^prod_[0-9a-f]{24}$/);
        expect(product.active).toBe(true);

        const price = await adapter.prices.create({
          product: product.id,
          unit_amount: 2000,
          currency: 'usd',
          recurring: { interval: 'month', interval_count: 1 },
        });
        expect(price.product).toBe(product.id);
        expect(price.unit_amount).toBe(2000);

        const customer = await adapter.customers.create({
          email: `test-${RUN_TAG}@integration.test`,
          metadata: { tenant_id: 'test-tenant' },
        });
        createdCustomers.push(customer.id);
        expect(customer.email).toBe(`test-${RUN_TAG}@integration.test`);

        const subscription = await adapter.subscriptions.create({
          customer: customer.id,
          items: [{ price: price.id }],
        });
        expect(subscription.customer).toBe(customer.id);
        expect(subscription.status).toBe('active');
        expect(subscription.items.data).toHaveLength(1);
        expect(subscription.items.data[0]!.price.id).toBe(price.id);
      });

      it('rejects subscription with unknown price_id (invalid_request semantics)', async () => {
        const customer = await adapter.customers.create({ email: `bad-${RUN_TAG}@integration.test` });
        createdCustomers.push(customer.id);
        await expect(
          adapter.subscriptions.create({
            customer: customer.id,
            items: [{ price: 'price_does_not_exist' }],
          }),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining('No such price') as unknown as string,
        });
      });

      it('rejects createBalanceTransaction with unknown customer_id', async () => {
        await expect(
          adapter.customers.createBalanceTransaction('cus_does_not_exist', {
            amount: -1000,
            currency: 'usd',
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it('subscriptions.cancel writes canceled_at + emits deleted event', async () => {
        const emittedEvents: VerifiedStripeEvent[] = [];
        const emitter: MockWebhookEmitter = {
          emit: (e) => {
            emittedEvents.push(e);
            return Promise.resolve();
          },
        };
        adapter.setEmitter(emitter);

        const product = await adapter.products.create({ name: `Cancel Test ${RUN_TAG}` });
        createdProducts.push(product.id);
        const price = await adapter.prices.create({
          product: product.id,
          unit_amount: 1000,
          currency: 'usd',
        });
        const customer = await adapter.customers.create({ email: `cancel-${RUN_TAG}@integration.test` });
        createdCustomers.push(customer.id);
        const sub = await adapter.subscriptions.create({
          customer: customer.id,
          items: [{ price: price.id }],
        });

        const canceled = await adapter.subscriptions.cancel(sub.id);
        expect(canceled.status).toBe('canceled');
        expect(canceled.canceled_at).not.toBeNull();

        const deletedEvent = emittedEvents.find(
          (e) => e.type === 'customer.subscription.deleted',
        );
        expect(deletedEvent).toBeDefined();
        adapter.setEmitter(null);
      });
    });

    describe('idempotency', () => {
      it('repeat call with same idempotencyKey returns the original response', async () => {
        const key = `idem-${RUN_TAG}-${crypto.randomUUID()}`;
        const first = await adapter.customers.create(
          { email: `idem-${RUN_TAG}@integration.test` },
          { idempotencyKey: key },
        );
        createdCustomers.push(first.id);
        const second = await adapter.customers.create(
          { email: `different-${RUN_TAG}@integration.test` },
          { idempotencyKey: key },
        );
        expect(second.id).toBe(first.id);
        expect(second.email).toBe(first.email);

        const { getPool } = await import('../../db/pool.js');
        const { rows } = await getPool().query('SELECT COUNT(*)::int AS n FROM stripe_mock.customers WHERE id = $1', [first.id]);
        expect(rows[0]!.n).toBe(1);
      });
    });

    describe('error injection (setNextError)', () => {
      it('forces the next call to throw rate_limit → AppError(429)', async () => {
        adapter.setNextError({ kind: 'rate_limit', message: 'burst too fast' });
        await expect(adapter.balance.retrieve()).rejects.toMatchObject({
          statusCode: 429,
          message: 'burst too fast',
        });
      });

      it('clears after firing (subsequent call succeeds)', async () => {
        adapter.setNextError({ kind: 'invalid_request', message: 'boom' });
        await expect(adapter.balance.retrieve()).rejects.toMatchObject({ statusCode: 400 });
        // Second call should succeed — spec was single-shot.
        const balance = await adapter.balance.retrieve();
        expect(balance.object).toBe('balance');
      });
    });

    describe('event emission', () => {
      it('subscriptions.update writes a stripe_mock.events row of type customer.subscription.updated', async () => {
        const product = await adapter.products.create({ name: `Event Test ${RUN_TAG}` });
        createdProducts.push(product.id);
        const price = await adapter.prices.create({
          product: product.id,
          unit_amount: 500,
          currency: 'usd',
        });
        const customer = await adapter.customers.create({ email: `evt-${RUN_TAG}@integration.test` });
        createdCustomers.push(customer.id);
        const sub = await adapter.subscriptions.create({
          customer: customer.id,
          items: [{ price: price.id }],
        });

        await adapter.subscriptions.update(sub.id, { cancel_at_period_end: true });

        const { getPool } = await import('../../db/pool.js');
        const { rows } = await getPool().query<{ type: string }>(
          `SELECT type FROM stripe_mock.events
            WHERE type = 'customer.subscription.updated'
              AND data->'object'->>'id' = $1`,
          [sub.id],
        );
        expect(rows.length).toBeGreaterThan(0);
      });
    });
  },
);
