// Authorized by HUB-1778 (S5 of HUB-1773) — programmatic Seeding API for the stripe_mock
// store. Every entry point:
//   1. asserts mock mode (S7 guard) — throws if the connection is LIVE
//   2. validates input through the same Zod schemas that MockStripeAdapter uses on reads
//      (so mock fixtures cannot violate the S2 contract even at seed time)
//   3. enforces relational integrity — orphan references throw before any INSERT
//   4. runs in a single transaction — either the whole batch commits or nothing does
//
// Types are exposed loosely (Partial<X>) at the seed layer so consumers can hand-write
// concise fixtures (e.g., `{ email: 'a@b.co' }`) without setting every optional field.
// Missing fields are filled in from sensible defaults (created = now(), metadata = {},
// etc.). Auto-generated IDs use the same mockId() helper as MockStripeAdapter.
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { assertMockMode } from './guard.js';

// ── ID generation (duplicated from mockAdapter.ts by design — decouples seed from adapter) ─
export function seedMockId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

// ── Input schemas ────────────────────────────────────────────────────────────────
// Loose-shape inputs matching Stripe create-params. IDs optional (auto-generated when
// absent). Timestamps default to now(). Metadata defaults to {}.

const nowSec = () => Math.floor(Date.now() / 1000);

const CustomerInput = z.object({
  id: z.string().optional(),
  created: z.number().int().nonnegative().optional(),
  email: z.string().email().nullable().optional(),
  name: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  livemode: z.boolean().optional(),
});
export type CustomerSeed = z.infer<typeof CustomerInput>;

const ProductInput = z.object({
  id: z.string().optional(),
  created: z.number().int().nonnegative().optional(),
  name: z.string(),
  active: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type ProductSeed = z.infer<typeof ProductInput>;

const PriceInput = z.object({
  id: z.string().optional(),
  created: z.number().int().nonnegative().optional(),
  product: z.string(),
  unit_amount: z.number().int().nullable().optional(),
  currency: z.string().length(3),
  active: z.boolean().optional(),
  recurring_interval: z.enum(['day', 'week', 'month', 'year']).nullable().optional(),
  recurring_interval_count: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type PriceSeed = z.infer<typeof PriceInput>;

const CouponInput = z.object({
  id: z.string().optional(),
  created: z.number().int().nonnegative().optional(),
  name: z.string().nullable().optional(),
  percent_off: z.number().nullable().optional(),
  amount_off: z.number().int().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  duration: z.enum(['forever', 'once', 'repeating']),
  duration_in_months: z.number().int().positive().nullable().optional(),
  valid: z.boolean().optional(),
});
export type CouponSeed = z.infer<typeof CouponInput>;

const SubscriptionInput = z.object({
  id: z.string().optional(),
  created: z.number().int().nonnegative().optional(),
  customer: z.string(),
  status: z.enum([
    'incomplete', 'incomplete_expired', 'trialing', 'active',
    'past_due', 'canceled', 'unpaid', 'paused',
  ]).optional(),
  current_period_start: z.number().int().nonnegative().optional(),
  current_period_end: z.number().int().nonnegative().optional(),
  cancel_at_period_end: z.boolean().optional(),
  canceled_at: z.number().int().nonnegative().nullable().optional(),
  items: z.array(z.object({
    price: z.string(),
    quantity: z.number().int().positive().optional(),
  })).min(1),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type SubscriptionSeed = z.infer<typeof SubscriptionInput>;

const InvoiceInput = z.object({
  id: z.string().optional(),
  created: z.number().int().nonnegative().optional(),
  customer: z.string(),
  subscription: z.string().nullable().optional(),
  status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).nullable().optional(),
  amount_due: z.number().int(),
  amount_paid: z.number().int().optional(),
  currency: z.string().length(3),
  period_start: z.number().int().nonnegative().optional(),
  period_end: z.number().int().nonnegative().optional(),
  invoice_pdf: z.string().url().nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type InvoiceSeed = z.infer<typeof InvoiceInput>;

const DiscountInput = z.object({
  id: z.string().optional(),
  coupon: z.string(),
  customer: z.string().nullable().optional(),
  subscription: z.string().nullable().optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().nullable().optional(),
});
export type DiscountSeed = z.infer<typeof DiscountInput>;

const BalanceTransactionInput = z.object({
  id: z.string().optional(),
  created: z.number().int().nonnegative().optional(),
  customer: z.string(),
  amount: z.number().int(),
  currency: z.string().length(3),
  description: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type BalanceTransactionSeed = z.infer<typeof BalanceTransactionInput>;

// ── Helpers ──────────────────────────────────────────────────────────────────────

type MaybeArray<T> = T | T[];
function toArray<T>(x: MaybeArray<T>): T[] {
  return Array.isArray(x) ? x : [x];
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function assertRefsExist(
  client: PoolClient,
  table: string,
  ids: readonly string[],
  refName: string,
): Promise<void> {
  if (ids.length === 0) return;
  const uniq = Array.from(new Set(ids));
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM stripe_mock.${table} WHERE id = ANY($1)`,
    [uniq],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = uniq.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError(400, `Orphaned ${refName} reference: ${missing.join(', ')}`);
  }
}

// Parses a batch of inputs. On any per-item validation failure, returns a per-index
// error report AND throws — matches AC4 all-or-nothing semantics.
function parseBatch<S extends z.ZodTypeAny>(
  schema: S,
  inputs: readonly unknown[],
  objectType: string,
): Array<z.output<S>> {
  const parsed: Array<z.output<S>> = [];
  const errors: Array<{ index: number; message: string }> = [];
  inputs.forEach((raw, i) => {
    const result = schema.safeParse(raw);
    if (result.success) {
      parsed.push(result.data);
    } else {
      errors.push({
        index: i,
        message: result.error.issues.map((iss) => `${iss.path.join('.')} ${iss.message}`).join('; '),
      });
    }
  });
  if (errors.length > 0) {
    throw new AppError(
      400,
      `Invalid ${objectType} inputs at index(es): ${errors.map((e) => `${e.index} (${e.message})`).join('; ')}`,
    );
  }
  return parsed;
}

// ── seed.customers ───────────────────────────────────────────────────────────────

const customersFacet = {
  async create(input: MaybeArray<CustomerSeed>): Promise<Array<{ id: string }>> {
    assertMockMode();
    const items = toArray(input);
    const parsed = parseBatch(CustomerInput, items, 'customer');
    return inTransaction(async (client) => {
      const results: Array<{ id: string }> = [];
      for (const c of parsed) {
        const id = c.id ?? seedMockId('cus');
        const created = c.created ?? nowSec();
        await client.query(
          `INSERT INTO stripe_mock.customers (id, created, email, name, metadata, livemode)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [id, created, c.email ?? null, c.name ?? null, JSON.stringify(c.metadata ?? {}), c.livemode ?? false],
        );
        results.push({ id });
      }
      return results;
    });
  },
};

// ── seed.products ────────────────────────────────────────────────────────────────

const productsFacet = {
  async create(input: MaybeArray<ProductSeed>): Promise<Array<{ id: string }>> {
    assertMockMode();
    const items = toArray(input);
    const parsed = parseBatch(ProductInput, items, 'product');
    return inTransaction(async (client) => {
      const results: Array<{ id: string }> = [];
      for (const p of parsed) {
        const id = p.id ?? seedMockId('prod');
        const created = p.created ?? nowSec();
        await client.query(
          `INSERT INTO stripe_mock.products (id, created, name, active, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [id, created, p.name, p.active ?? true, JSON.stringify(p.metadata ?? {})],
        );
        results.push({ id });
      }
      return results;
    });
  },
};

// ── seed.prices ──────────────────────────────────────────────────────────────────

const pricesFacet = {
  async create(input: MaybeArray<PriceSeed>): Promise<Array<{ id: string }>> {
    assertMockMode();
    const items = toArray(input);
    const parsed = parseBatch(PriceInput, items, 'price');
    return inTransaction(async (client) => {
      await assertRefsExist(client, 'products', parsed.map((p) => p.product), 'product');
      const results: Array<{ id: string }> = [];
      for (const p of parsed) {
        const id = p.id ?? seedMockId('price');
        const created = p.created ?? nowSec();
        await client.query(
          `INSERT INTO stripe_mock.prices
             (id, created, product, unit_amount, currency, active,
              recurring_interval, recurring_interval_count, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            id, created, p.product, p.unit_amount ?? null, p.currency, p.active ?? true,
            p.recurring_interval ?? null, p.recurring_interval_count ?? null,
            JSON.stringify(p.metadata ?? {}),
          ],
        );
        results.push({ id });
      }
      return results;
    });
  },
};

// ── seed.coupons ─────────────────────────────────────────────────────────────────

const couponsFacet = {
  async create(input: MaybeArray<CouponSeed>): Promise<Array<{ id: string }>> {
    assertMockMode();
    const items = toArray(input);
    const parsed = parseBatch(CouponInput, items, 'coupon');
    return inTransaction(async (client) => {
      const results: Array<{ id: string }> = [];
      for (const c of parsed) {
        const id = c.id ?? seedMockId('coup');
        const created = c.created ?? nowSec();
        await client.query(
          `INSERT INTO stripe_mock.coupons
             (id, created, name, percent_off, amount_off, currency,
              duration, duration_in_months, valid)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id, created, c.name ?? null, c.percent_off ?? null, c.amount_off ?? null,
            c.currency ?? null, c.duration, c.duration_in_months ?? null, c.valid ?? true,
          ],
        );
        results.push({ id });
      }
      return results;
    });
  },
};

// ── seed.subscriptions ───────────────────────────────────────────────────────────

const subscriptionsFacet = {
  async create(input: MaybeArray<SubscriptionSeed>): Promise<Array<{ id: string }>> {
    assertMockMode();
    const items = toArray(input);
    const parsed = parseBatch(SubscriptionInput, items, 'subscription');
    return inTransaction(async (client) => {
      await assertRefsExist(client, 'customers', parsed.map((s) => s.customer), 'customer');
      const priceIds = parsed.flatMap((s) => s.items.map((it) => it.price));
      await assertRefsExist(client, 'prices', priceIds, 'price');

      // Prefetch price details so we can build the items JSONB.
      const { rows: priceRows } = await client.query<{
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
        [Array.from(new Set(priceIds))],
      );
      const priceById = new Map(priceRows.map((r) => [r.id, r]));

      const results: Array<{ id: string }> = [];
      for (const s of parsed) {
        const id = s.id ?? seedMockId('sub');
        const created = s.created ?? nowSec();
        const cpStart = s.current_period_start ?? created;
        const cpEnd = s.current_period_end ?? created + 30 * 24 * 60 * 60;
        const itemsJson = {
          object: 'list',
          data: s.items.map((it) => {
            const p = priceById.get(it.price)!;
            return {
              id: seedMockId('si'),
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
                      interval: p.recurring_interval,
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
        await client.query(
          `INSERT INTO stripe_mock.subscriptions
             (id, created, customer, status, current_period_start, current_period_end,
              cancel_at_period_end, canceled_at, items, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
          [
            id, created, s.customer, s.status ?? 'active', cpStart, cpEnd,
            s.cancel_at_period_end ?? false, s.canceled_at ?? null,
            JSON.stringify(itemsJson), JSON.stringify(s.metadata ?? {}),
          ],
        );
        results.push({ id });
      }
      return results;
    });
  },
};

// ── seed.invoices ────────────────────────────────────────────────────────────────

const invoicesFacet = {
  async create(input: MaybeArray<InvoiceSeed>): Promise<Array<{ id: string }>> {
    assertMockMode();
    const items = toArray(input);
    const parsed = parseBatch(InvoiceInput, items, 'invoice');
    return inTransaction(async (client) => {
      await assertRefsExist(client, 'customers', parsed.map((i) => i.customer), 'customer');
      const subIds = parsed.map((i) => i.subscription).filter((v): v is string => !!v);
      await assertRefsExist(client, 'subscriptions', subIds, 'subscription');

      const results: Array<{ id: string }> = [];
      for (const inv of parsed) {
        const id = inv.id ?? seedMockId('in');
        const created = inv.created ?? nowSec();
        const parent = inv.subscription
          ? { type: 'subscription_details', subscription_details: { subscription: inv.subscription } }
          : null;
        await client.query(
          `INSERT INTO stripe_mock.invoices
             (id, created, customer, parent, status, amount_due, amount_paid,
              currency, period_start, period_end, invoice_pdf, metadata)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
          [
            id, created, inv.customer, JSON.stringify(parent),
            inv.status ?? 'draft', inv.amount_due, inv.amount_paid ?? 0,
            inv.currency, inv.period_start ?? created, inv.period_end ?? created + 30 * 24 * 60 * 60,
            inv.invoice_pdf ?? null, JSON.stringify(inv.metadata ?? {}),
          ],
        );
        results.push({ id });
      }
      return results;
    });
  },
};

// ── seed.discounts ───────────────────────────────────────────────────────────────

const discountsFacet = {
  async create(input: MaybeArray<DiscountSeed>): Promise<Array<{ id: string }>> {
    assertMockMode();
    const items = toArray(input);
    const parsed = parseBatch(DiscountInput, items, 'discount');
    return inTransaction(async (client) => {
      await assertRefsExist(client, 'coupons', parsed.map((d) => d.coupon), 'coupon');
      const custIds = parsed.map((d) => d.customer).filter((v): v is string => !!v);
      await assertRefsExist(client, 'customers', custIds, 'customer');
      const subIds = parsed.map((d) => d.subscription).filter((v): v is string => !!v);
      await assertRefsExist(client, 'subscriptions', subIds, 'subscription');

      const results: Array<{ id: string }> = [];
      for (const d of parsed) {
        const id = d.id ?? seedMockId('di');
        const start = d.start ?? nowSec();
        await client.query(
          `INSERT INTO stripe_mock.discounts (id, coupon_id, customer, subscription, start, "end")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, d.coupon, d.customer ?? null, d.subscription ?? null, start, d.end ?? null],
        );
        results.push({ id });
      }
      return results;
    });
  },
};

// ── seed.balanceTransactions ─────────────────────────────────────────────────────

const balanceTransactionsFacet = {
  async create(input: MaybeArray<BalanceTransactionSeed>): Promise<Array<{ id: string }>> {
    assertMockMode();
    const items = toArray(input);
    const parsed = parseBatch(BalanceTransactionInput, items, 'balance_transaction');
    return inTransaction(async (client) => {
      await assertRefsExist(client, 'customers', parsed.map((b) => b.customer), 'customer');
      const results: Array<{ id: string }> = [];
      for (const b of parsed) {
        const id = b.id ?? seedMockId('cbtxn');
        const created = b.created ?? nowSec();
        await client.query(
          `INSERT INTO stripe_mock.balance_transactions
             (id, created, customer, amount, currency, description, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            id, created, b.customer, b.amount, b.currency,
            b.description ?? null, JSON.stringify(b.metadata ?? {}),
          ],
        );
        results.push({ id });
      }
      return results;
    });
  },
};

// ── seed.reset — truncate all stripe_mock.* tables ───────────────────────────────

async function reset(): Promise<void> {
  assertMockMode();
  await getPool().query(
    `TRUNCATE
       stripe_mock.discounts,
       stripe_mock.balance_transactions,
       stripe_mock.invoices,
       stripe_mock.subscription_schedules,
       stripe_mock.subscriptions,
       stripe_mock.prices,
       stripe_mock.products,
       stripe_mock.coupons,
       stripe_mock.customers,
       stripe_mock.events,
       stripe_mock.idempotency_keys
     RESTART IDENTITY CASCADE`,
  );
}

// ── seed.snapshot — row counts per table (test assertions) ───────────────────────

export interface SeedSnapshot {
  customers: number;
  products: number;
  prices: number;
  coupons: number;
  subscriptions: number;
  subscription_schedules: number;
  invoices: number;
  discounts: number;
  balance_transactions: number;
  events: number;
}

async function snapshot(): Promise<SeedSnapshot> {
  const tables: Array<keyof SeedSnapshot> = [
    'customers', 'products', 'prices', 'coupons',
    'subscriptions', 'subscription_schedules', 'invoices',
    'discounts', 'balance_transactions', 'events',
  ];
  const counts = Object.fromEntries(tables.map((t) => [t, 0])) as unknown as SeedSnapshot;
  for (const t of tables) {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM stripe_mock.${t}`,
    );
    counts[t] = rows[0]!.n;
  }
  return counts;
}

// ── Exported façade ──────────────────────────────────────────────────────────────

export const seed = {
  customers: customersFacet,
  products: productsFacet,
  prices: pricesFacet,
  coupons: couponsFacet,
  subscriptions: subscriptionsFacet,
  invoices: invoicesFacet,
  discounts: discountsFacet,
  balanceTransactions: balanceTransactionsFacet,
  reset,
  snapshot,
};
