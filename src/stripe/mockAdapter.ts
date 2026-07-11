// Authorized by HUB-1777 (S4 of HUB-1773) — MockStripeAdapter implements StripeConnection
// against the stripe_mock.* PG schema. Reads return Stripe-shaped objects validated through
// the S2 Zod schemas; writes produce webhook events into stripe_mock.events (and optionally
// an injected downstream emitter so integration tests can drive HUB's real invoice/subscription
// pipelines end-to-end without hitting Stripe).
//
// No pagination methods are exposed because the StripeConnection interface currently has no
// list operations (HUB only reads by ID). When HUB adds list operations, we add both the
// interface method AND the corresponding cursor logic here.
//
// Idempotency: mutations that pass an idempotencyKey are recorded in stripe_mock.idempotency_keys
// with a 24h TTL; repeat calls with the same key return the original response verbatim, matching
// live Stripe semantics.
//
// Test hooks: setNextError() forces the next call to throw with a specific Stripe error, so
// failure-path tests can drive rate-limit / invalid-request / etc. without real SDK plumbing.
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import type {
  StripeConnection,
  StripeCustomersFacet,
  StripeSubscriptionsFacet,
  StripeSubscriptionSchedulesFacet,
  StripeProductsFacet,
  StripePricesFacet,
  StripeInvoicesFacet,
  StripeCouponsFacet,
  StripeBalanceFacet,
  StripeWebhooksFacet,
  StripeRequestOptions,
  CreateCustomerInput,
  UpdateCustomerInput,
  CreateCustomerBalanceTransactionInput,
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  CreateSubscriptionScheduleInput,
  UpdateSubscriptionScheduleInput,
  CreateProductInput,
  CreatePriceInput,
  CreateCouponInput,
  VerifiedStripeEvent,
} from './connection.js';
import {
  BalanceSchema,
  BalanceTransactionSchema,
  CouponSchema,
  CustomerSchema,
  InvoiceSchema,
  PriceSchema,
  ProductSchema,
  SubscriptionSchema,
  SubscriptionScheduleSchema,
  type Balance,
  type BalanceTransaction,
  type Coupon,
  type Customer,
  type Invoice,
  type Price,
  type Product,
  type Subscription,
  type SubscriptionSchedule,
} from './schemas.js';

// ── Stripe API version served by the mock ───────────────────────────────────────
const MOCK_API_VERSION = '2026-05-27.dahlia';

// ── ID generation ───────────────────────────────────────────────────────────────
// Produces Stripe-style IDs: `<prefix>_<24 hex chars>`.
export function mockId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

// ── Injectable webhook emitter ──────────────────────────────────────────────────
// Contract tests inject a mock emitter to capture the emitted events; production use
// can wire the real BullMQ queue lookup (getQueueForEventType) here.
export interface MockWebhookEmitter {
  emit(event: VerifiedStripeEvent): Promise<void>;
}

// ── Injected error type (for the setNextError test hook) ────────────────────────
type MockErrorSpec =
  | { kind: 'invalid_request'; message: string }
  | { kind: 'rate_limit'; message: string }
  | { kind: 'not_found'; resourceId: string }
  | { kind: 'raw'; error: Error };

function throwMockError(spec: MockErrorSpec): never {
  switch (spec.kind) {
    case 'invalid_request':
      throw new AppError(400, spec.message);
    case 'rate_limit':
      throw new AppError(429, spec.message);
    case 'not_found':
      throw new AppError(400, `No such resource: ${spec.resourceId}`);
    case 'raw':
      throw spec.error;
  }
}

// ── State: shared between facets via the adapter singleton ─────────────────────
interface MockAdapterState {
  nextError: MockErrorSpec | null;
  emitter: MockWebhookEmitter | null;
}

// ── Idempotency helper ──────────────────────────────────────────────────────────
// Reads any stored response for the (key, method) pair; if within TTL, returns it.
// Otherwise runs the operation and stores the response for future replays.
async function withIdempotency<T>(
  method: string,
  options: StripeRequestOptions | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const key = options?.idempotencyKey;
  if (!key) return run();

  const pool = getPool();
  const TTL_SECONDS = 24 * 60 * 60;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Read-through: return cached response if fresh.
  const { rows } = await pool.query<{ response: unknown; created: string }>(
    `SELECT response, created FROM stripe_mock.idempotency_keys
      WHERE key = $1 AND method = $2 AND created > $3`,
    [key, method, nowSeconds - TTL_SECONDS],
  );
  if (rows[0]) {
    return rows[0].response as T;
  }

  const result = await run();
  await pool.query(
    `INSERT INTO stripe_mock.idempotency_keys (key, method, response, created)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (key) DO NOTHING`,
    [key, method, JSON.stringify(result), nowSeconds],
  );
  return result;
}

// ── Event emission ──────────────────────────────────────────────────────────────
// Every write to stripe_mock.events also invokes the injected emitter (if any).
// The emitter is optional so unit tests can run without any queue wiring.
async function emitEvent(
  state: MockAdapterState,
  client: PoolClient | null,
  type: string,
  object: unknown,
): Promise<void> {
  const id = mockId('evt');
  const created = Math.floor(Date.now() / 1000);
  const event: VerifiedStripeEvent = {
    id,
    type,
    api_version: MOCK_API_VERSION,
    created,
    livemode: false,
    data: { object },
  };
  const runner = client ?? getPool();
  await runner.query(
    `INSERT INTO stripe_mock.events (id, type, api_version, created, livemode, data)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, type, MOCK_API_VERSION, created, false, JSON.stringify(event.data)],
  );
  if (state.emitter) {
    await state.emitter.emit(event);
  }
}

// ── Facets ──────────────────────────────────────────────────────────────────────

class MockCustomersFacet implements StripeCustomersFacet {
  constructor(private readonly state: MockAdapterState) {}

  async create(input: CreateCustomerInput, options?: StripeRequestOptions): Promise<Customer> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('customers.create', options, async () => {
      const id = mockId('cus');
      const created = Math.floor(Date.now() / 1000);
      const pool = getPool();
      await pool.query(
        `INSERT INTO stripe_mock.customers (id, created, email, metadata)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [id, created, input.email ?? null, JSON.stringify(input.metadata ?? {})],
      );
      return CustomerSchema.parse({
        id,
        object: 'customer',
        created,
        email: input.email ?? null,
        name: null,
        metadata: input.metadata ?? {},
        livemode: false,
      });
    });
  }

  async update(id: string, input: UpdateCustomerInput, options?: StripeRequestOptions): Promise<Customer> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('customers.update', options, async () => {
      const pool = getPool();
      const { rows } = await pool.query<{
        id: string;
        created: string;
        email: string | null;
        name: string | null;
        metadata: Record<string, string>;
        livemode: boolean;
      }>(
        `UPDATE stripe_mock.customers
            SET metadata = COALESCE($2::jsonb, metadata)
          WHERE id = $1
      RETURNING id, created, email, name, metadata, livemode`,
        [id, input.metadata ? JSON.stringify(input.metadata) : null],
      );
      if (!rows[0]) throwMockError({ kind: 'not_found', resourceId: id });

      // Attaching a coupon creates a discount row for the customer.
      if (input.coupon) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        await pool.query(
          `INSERT INTO stripe_mock.discounts (id, coupon_id, customer, start)
           VALUES ($1, $2, $3, $4)`,
          [mockId('di'), input.coupon, id, nowSeconds],
        );
      }

      return CustomerSchema.parse({
        id: rows[0]!.id,
        object: 'customer',
        created: Number(rows[0]!.created),
        email: rows[0]!.email,
        name: rows[0]!.name,
        metadata: rows[0]!.metadata,
        livemode: rows[0]!.livemode,
      });
    });
  }

  async createBalanceTransaction(
    customerId: string,
    input: CreateCustomerBalanceTransactionInput,
    options?: StripeRequestOptions,
  ): Promise<BalanceTransaction> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('customers.createBalanceTransaction', options, async () => {
      const id = mockId('cbtxn');
      const created = Math.floor(Date.now() / 1000);
      const pool = getPool();
      // Enforce FK-like existence for the parent customer up front so the mock
      // matches Stripe's not-found semantics rather than surfacing a raw PG FK error.
      const { rows: parent } = await pool.query('SELECT 1 FROM stripe_mock.customers WHERE id = $1', [
        customerId,
      ]);
      if (!parent[0]) throwMockError({ kind: 'not_found', resourceId: customerId });

      await pool.query(
        `INSERT INTO stripe_mock.balance_transactions
           (id, created, customer, amount, currency, description, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          id,
          created,
          customerId,
          input.amount,
          input.currency,
          input.description ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return BalanceTransactionSchema.parse({
        id,
        object: 'customer_balance_transaction',
        created,
        customer: customerId,
        amount: input.amount,
        currency: input.currency,
        description: input.description ?? null,
        metadata: input.metadata ?? {},
      });
    });
  }

  async deleteDiscount(customerId: string, _options?: StripeRequestOptions): Promise<void> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    const pool = getPool();
    await pool.query(`DELETE FROM stripe_mock.discounts WHERE customer = $1`, [customerId]);
  }
}

class MockSubscriptionsFacet implements StripeSubscriptionsFacet {
  constructor(private readonly state: MockAdapterState) {}

  async create(input: CreateSubscriptionInput, options?: StripeRequestOptions): Promise<Subscription> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('subscriptions.create', options, async () => {
      const pool = getPool();
      // Look up prices to build the items JSONB (mock enforces referential integrity here
      // so an invalid price_id surfaces as invalid_request, matching Stripe.).
      const priceIds = input.items.map((i) => i.price);
      const { rows: priceRows } = await pool.query<{
        id: string;
        product: string;
        unit_amount: string | null;
        currency: string;
        active: boolean;
        recurring_interval: string | null;
        recurring_interval_count: number | null;
        created: string;
      }>(
        `SELECT id, product, unit_amount, currency, active,
                recurring_interval, recurring_interval_count, created
           FROM stripe_mock.prices WHERE id = ANY($1)`,
        [priceIds],
      );
      const priceById = new Map(priceRows.map((r) => [r.id, r]));
      for (const inputItem of input.items) {
        if (!priceById.has(inputItem.price)) {
          throwMockError({ kind: 'invalid_request', message: `No such price: ${inputItem.price}` });
        }
      }

      const id = mockId('sub');
      const created = Math.floor(Date.now() / 1000);
      const periodEnd = created + 30 * 24 * 60 * 60;
      const items = {
        object: 'list',
        data: input.items.map((it) => {
          const p = priceById.get(it.price)!;
          return {
            id: mockId('si'),
            object: 'subscription_item',
            price: {
              id: p.id,
              object: 'price',
              created: Number(p.created),
              product: p.product,
              unit_amount: p.unit_amount === null ? null : Number(p.unit_amount),
              currency: p.currency,
              active: p.active,
              recurring: p.recurring_interval
                ? {
                    interval: p.recurring_interval as 'day' | 'week' | 'month' | 'year',
                    interval_count: p.recurring_interval_count ?? 1,
                  }
                : null,
              metadata: {},
            },
            quantity: it.quantity ?? 1,
          };
        }),
        has_more: false,
      };

      await pool.query(
        `INSERT INTO stripe_mock.subscriptions
           (id, created, customer, status, current_period_start, current_period_end,
            cancel_at_period_end, canceled_at, items, metadata, livemode)
         VALUES ($1, $2, $3, 'active', $2, $4, false, NULL, $5::jsonb, $6::jsonb, false)`,
        [id, created, input.customer, periodEnd, JSON.stringify(items), JSON.stringify(input.metadata ?? {})],
      );

      return SubscriptionSchema.parse({
        id,
        object: 'subscription',
        created,
        customer: input.customer,
        status: 'active',
        current_period_start: created,
        current_period_end: periodEnd,
        cancel_at_period_end: false,
        canceled_at: null,
        items,
        metadata: input.metadata ?? {},
        livemode: false,
      });
    });
  }

  async retrieve(id: string, _options?: StripeRequestOptions): Promise<Subscription> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      created: string;
      customer: string;
      status: string;
      current_period_start: string;
      current_period_end: string;
      cancel_at_period_end: boolean;
      canceled_at: string | null;
      items: unknown;
      metadata: Record<string, string>;
      livemode: boolean;
    }>(
      `SELECT id, created, customer, status, current_period_start, current_period_end,
              cancel_at_period_end, canceled_at, items, metadata, livemode
         FROM stripe_mock.subscriptions WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throwMockError({ kind: 'not_found', resourceId: id });
    return SubscriptionSchema.parse({
      id: rows[0]!.id,
      object: 'subscription',
      created: Number(rows[0]!.created),
      customer: rows[0]!.customer,
      status: rows[0]!.status,
      current_period_start: Number(rows[0]!.current_period_start),
      current_period_end: Number(rows[0]!.current_period_end),
      cancel_at_period_end: rows[0]!.cancel_at_period_end,
      canceled_at: rows[0]!.canceled_at === null ? null : Number(rows[0]!.canceled_at),
      items: rows[0]!.items,
      metadata: rows[0]!.metadata,
      livemode: rows[0]!.livemode,
    });
  }

  async update(id: string, input: UpdateSubscriptionInput, options?: StripeRequestOptions): Promise<Subscription> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('subscriptions.update', options, async () => {
      const pool = getPool();
      const setFragments: string[] = [];
      const values: unknown[] = [id];
      let idx = 2;
      if (input.cancel_at_period_end !== undefined) {
        setFragments.push(`cancel_at_period_end = $${idx++}`);
        values.push(input.cancel_at_period_end);
      }
      if (input.metadata !== undefined) {
        setFragments.push(`metadata = $${idx++}::jsonb`);
        values.push(JSON.stringify(input.metadata));
      }
      if (setFragments.length === 0) {
        // No-op update — just return the existing row.
        return this.retrieve(id);
      }
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE stripe_mock.subscriptions SET ${setFragments.join(', ')} WHERE id = $1 RETURNING id`,
        values,
      );
      if (!rows[0]) throwMockError({ kind: 'not_found', resourceId: id });
      const sub = await this.retrieve(id);
      await emitEvent(this.state, null, 'customer.subscription.updated', sub);
      return sub;
    });
  }

  async cancel(id: string, options?: StripeRequestOptions): Promise<Subscription> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('subscriptions.cancel', options, async () => {
      const pool = getPool();
      const canceledAt = Math.floor(Date.now() / 1000);
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE stripe_mock.subscriptions
            SET status = 'canceled', canceled_at = $2
          WHERE id = $1 RETURNING id`,
        [id, canceledAt],
      );
      if (!rows[0]) throwMockError({ kind: 'not_found', resourceId: id });
      const sub = await this.retrieve(id);
      await emitEvent(this.state, null, 'customer.subscription.deleted', sub);
      return sub;
    });
  }
}

class MockSubscriptionSchedulesFacet implements StripeSubscriptionSchedulesFacet {
  constructor(private readonly state: MockAdapterState) {}

  async create(
    input: CreateSubscriptionScheduleInput,
    options?: StripeRequestOptions,
  ): Promise<SubscriptionSchedule> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('subscriptionSchedules.create', options, async () => {
      const id = mockId('sub_sched');
      const created = Math.floor(Date.now() / 1000);
      const pool = getPool();

      // Resolve customer from input or from source subscription.
      let customer = input.customer ?? null;
      if (!customer && input.from_subscription) {
        const { rows } = await pool.query<{ customer: string }>(
          `SELECT customer FROM stripe_mock.subscriptions WHERE id = $1`,
          [input.from_subscription],
        );
        if (!rows[0]) {
          throwMockError({ kind: 'invalid_request', message: `No such subscription: ${input.from_subscription}` });
        }
        customer = rows[0].customer;
      }
      if (!customer) {
        throwMockError({ kind: 'invalid_request', message: 'customer or from_subscription required' });
      }

      await pool.query(
        `INSERT INTO stripe_mock.subscription_schedules
           (id, created, customer, subscription, status, phases, metadata)
         VALUES ($1, $2, $3, $4, 'not_started', $5::jsonb, $6::jsonb)`,
        [
          id,
          created,
          customer,
          input.from_subscription ?? null,
          JSON.stringify(input.phases),
          JSON.stringify(input.metadata ?? {}),
        ],
      );

      return SubscriptionScheduleSchema.parse({
        id,
        object: 'subscription_schedule',
        created,
        customer,
        subscription: input.from_subscription ?? null,
        status: 'not_started',
        // When from_subscription is supplied without explicit phases, we mint a
        // single trivial phase; real Stripe infers from the source subscription.
        phases: (input.phases ?? []).map((ph) => ({
          start_date: created,
          end_date: null,
          items: ph.items.map((it) => ({ price: it.price ?? '', quantity: it.quantity ?? 1 })),
        })),
        current_phase: null,
        metadata: input.metadata ?? {},
      });
    });
  }

  async update(
    id: string,
    input: UpdateSubscriptionScheduleInput,
    options?: StripeRequestOptions,
  ): Promise<SubscriptionSchedule> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('subscriptionSchedules.update', options, async () => {
      const pool = getPool();
      if (input.phases) {
        await pool.query(
          `UPDATE stripe_mock.subscription_schedules SET phases = $2::jsonb WHERE id = $1`,
          [id, JSON.stringify(input.phases)],
        );
      }
      const { rows } = await pool.query<{
        id: string;
        created: string;
        customer: string;
        subscription: string | null;
        status: string;
        phases: unknown;
        current_phase_start: string | null;
        current_phase_end: string | null;
        metadata: Record<string, string>;
      }>(
        `SELECT id, created, customer, subscription, status, phases,
                current_phase_start, current_phase_end, metadata
           FROM stripe_mock.subscription_schedules WHERE id = $1`,
        [id],
      );
      if (!rows[0]) throwMockError({ kind: 'not_found', resourceId: id });
      const currentPhase =
        rows[0]!.current_phase_start !== null && rows[0]!.current_phase_end !== null
          ? { start_date: Number(rows[0]!.current_phase_start), end_date: Number(rows[0]!.current_phase_end) }
          : null;
      return SubscriptionScheduleSchema.parse({
        id: rows[0]!.id,
        object: 'subscription_schedule',
        created: Number(rows[0]!.created),
        customer: rows[0]!.customer,
        subscription: rows[0]!.subscription,
        status: rows[0]!.status,
        phases: rows[0]!.phases,
        current_phase: currentPhase,
        metadata: rows[0]!.metadata,
      });
    });
  }
}

class MockProductsFacet implements StripeProductsFacet {
  constructor(private readonly state: MockAdapterState) {}

  async create(input: CreateProductInput, options?: StripeRequestOptions): Promise<Product> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('products.create', options, async () => {
      const id = mockId('prod');
      const created = Math.floor(Date.now() / 1000);
      const pool = getPool();
      await pool.query(
        `INSERT INTO stripe_mock.products (id, created, name, active, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [id, created, input.name, input.active ?? true, JSON.stringify(input.metadata ?? {})],
      );
      return ProductSchema.parse({
        id,
        object: 'product',
        created,
        name: input.name,
        active: input.active ?? true,
        metadata: input.metadata ?? {},
      });
    });
  }
}

class MockPricesFacet implements StripePricesFacet {
  constructor(private readonly state: MockAdapterState) {}

  async create(input: CreatePriceInput, options?: StripeRequestOptions): Promise<Price> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('prices.create', options, async () => {
      const pool = getPool();
      const { rows: parent } = await pool.query('SELECT 1 FROM stripe_mock.products WHERE id = $1', [
        input.product,
      ]);
      if (!parent[0]) throwMockError({ kind: 'invalid_request', message: `No such product: ${input.product}` });

      const id = mockId('price');
      const created = Math.floor(Date.now() / 1000);
      await pool.query(
        `INSERT INTO stripe_mock.prices
           (id, created, product, unit_amount, currency, active,
            recurring_interval, recurring_interval_count, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          id,
          created,
          input.product,
          input.unit_amount,
          input.currency,
          input.active ?? true,
          input.recurring?.interval ?? null,
          input.recurring?.interval_count ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return PriceSchema.parse({
        id,
        object: 'price',
        created,
        product: input.product,
        unit_amount: input.unit_amount,
        currency: input.currency,
        active: input.active ?? true,
        recurring: input.recurring
          ? { interval: input.recurring.interval, interval_count: input.recurring.interval_count ?? 1 }
          : null,
        metadata: input.metadata ?? {},
      });
    });
  }
}

class MockInvoicesFacet implements StripeInvoicesFacet {
  constructor(private readonly state: MockAdapterState) {}

  async pay(id: string, options?: StripeRequestOptions): Promise<Invoice> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('invoices.pay', options, async () => {
      const pool = getPool();
      const { rows } = await pool.query<{
        amount_due: string;
        status: string | null;
      }>(`SELECT amount_due, status FROM stripe_mock.invoices WHERE id = $1`, [id]);
      if (!rows[0]) throwMockError({ kind: 'not_found', resourceId: id });

      // Mark paid + emit event, then return the fresh row.
      await pool.query(
        `UPDATE stripe_mock.invoices SET status = 'paid', amount_paid = amount_due WHERE id = $1`,
        [id],
      );
      const { rows: fresh } = await pool.query<{
        id: string;
        created: string;
        customer: string;
        parent: unknown;
        status: string;
        amount_due: string;
        amount_paid: string;
        currency: string;
        period_start: string;
        period_end: string;
        invoice_pdf: string | null;
        lines: unknown;
        metadata: Record<string, string>;
      }>(
        `SELECT id, created, customer, parent, status, amount_due, amount_paid,
                currency, period_start, period_end, invoice_pdf, lines, metadata
           FROM stripe_mock.invoices WHERE id = $1`,
        [id],
      );
      const invoice = InvoiceSchema.parse({
        id: fresh[0]!.id,
        object: 'invoice',
        created: Number(fresh[0]!.created),
        customer: fresh[0]!.customer,
        parent: fresh[0]!.parent,
        status: fresh[0]!.status,
        amount_due: Number(fresh[0]!.amount_due),
        amount_paid: Number(fresh[0]!.amount_paid),
        currency: fresh[0]!.currency,
        period_start: Number(fresh[0]!.period_start),
        period_end: Number(fresh[0]!.period_end),
        invoice_pdf: fresh[0]!.invoice_pdf,
        lines: fresh[0]!.lines,
        metadata: fresh[0]!.metadata,
      });
      await emitEvent(this.state, null, 'invoice.payment_succeeded', invoice);
      return invoice;
    });
  }
}

class MockCouponsFacet implements StripeCouponsFacet {
  constructor(private readonly state: MockAdapterState) {}

  async create(input: CreateCouponInput, options?: StripeRequestOptions): Promise<Coupon> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return withIdempotency('coupons.create', options, async () => {
      const id = input.id ?? mockId('coup');
      const created = Math.floor(Date.now() / 1000);
      const pool = getPool();
      await pool.query(
        `INSERT INTO stripe_mock.coupons
           (id, created, name, percent_off, amount_off, currency, duration, duration_in_months, valid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [
          id,
          created,
          input.name ?? null,
          input.percent_off ?? null,
          input.amount_off ?? null,
          input.currency ?? null,
          input.duration,
          input.duration_in_months ?? null,
        ],
      );
      return CouponSchema.parse({
        id,
        object: 'coupon',
        created,
        name: input.name ?? null,
        percent_off: input.percent_off ?? null,
        amount_off: input.amount_off ?? null,
        currency: input.currency ?? null,
        duration: input.duration,
        duration_in_months: input.duration_in_months ?? null,
        valid: true,
      });
    });
  }
}

class MockBalanceFacet implements StripeBalanceFacet {
  constructor(private readonly state: MockAdapterState) {}

  async retrieve(_options?: StripeRequestOptions): Promise<Balance> {
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    return BalanceSchema.parse({
      object: 'balance',
      available: [{ amount: 0, currency: 'usd' }],
      pending: [{ amount: 0, currency: 'usd' }],
      livemode: false,
    });
  }
}

class MockWebhooksFacet implements StripeWebhooksFacet {
  constructor(private readonly state: MockAdapterState) {}

  constructEvent(
    payload: string | Buffer,
    _signatureHeader: string,
    _secret: string,
  ): VerifiedStripeEvent {
    // Mock signature verification: accept any signature; caller is responsible for having
    // signed with the mock's own signer if the contract test wants signature parity. The
    // payload is expected to be a JSON serialization of a VerifiedStripeEvent-shaped object.
    if (this.state.nextError) {
      const err = this.state.nextError;
      this.state.nextError = null;
      throwMockError(err);
    }
    const raw = typeof payload === 'string' ? payload : payload.toString('utf8');
    const parsed = JSON.parse(raw) as VerifiedStripeEvent;
    return parsed;
  }
}

// ── MockStripeAdapter ───────────────────────────────────────────────────────────

export class MockStripeAdapter implements StripeConnection {
  readonly balance: StripeBalanceFacet;
  readonly customers: StripeCustomersFacet;
  readonly subscriptions: StripeSubscriptionsFacet;
  readonly subscriptionSchedules: StripeSubscriptionSchedulesFacet;
  readonly products: StripeProductsFacet;
  readonly prices: StripePricesFacet;
  readonly invoices: StripeInvoicesFacet;
  readonly coupons: StripeCouponsFacet;
  readonly webhooks: StripeWebhooksFacet;

  private readonly state: MockAdapterState;

  constructor(emitter: MockWebhookEmitter | null = null) {
    this.state = { nextError: null, emitter };
    this.balance = new MockBalanceFacet(this.state);
    this.customers = new MockCustomersFacet(this.state);
    this.subscriptions = new MockSubscriptionsFacet(this.state);
    this.subscriptionSchedules = new MockSubscriptionSchedulesFacet(this.state);
    this.products = new MockProductsFacet(this.state);
    this.prices = new MockPricesFacet(this.state);
    this.invoices = new MockInvoicesFacet(this.state);
    this.coupons = new MockCouponsFacet(this.state);
    this.webhooks = new MockWebhooksFacet(this.state);
  }

  /**
   * Force the NEXT call to throw the specified Stripe-style error. Cleared automatically
   * after firing. Enables failure-path tests without SDK plumbing.
   */
  setNextError(spec: MockErrorSpec): void {
    this.state.nextError = spec;
  }

  /** Swap the webhook emitter at runtime (used by contract tests). */
  setEmitter(emitter: MockWebhookEmitter | null): void {
    this.state.emitter = emitter;
  }
}
