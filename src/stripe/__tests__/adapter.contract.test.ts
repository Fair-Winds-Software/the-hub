// Authorized by HUB-1777 (S4 of HUB-1773) — contract test harness. Runs the SAME
// behavioral suite against both LiveStripeAdapter (SDK mocked) and MockStripeAdapter
// (against stripe_mock.*). Proves the two adapters satisfy the StripeConnection
// interface identically at the observable-behavior layer, which is the guarantee HUB
// callers depend on when swapping adapters via the S8 registry.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type Stripe from 'stripe';
import { LiveStripeAdapter } from '../liveAdapter.js';
import { MockStripeAdapter } from '../mockAdapter.js';
import type { StripeConnection } from '../connection.js';

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';
const RUN_TAG = Date.now().toString();

function makeSdkMock(): Stripe {
  const sdk = {
    customers: {
      create: vi.fn(),
      update: vi.fn(),
      createBalanceTransaction: vi.fn(),
      deleteDiscount: vi.fn(),
    },
    subscriptions: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
    subscriptionSchedules: { create: vi.fn(), update: vi.fn() },
    products: { create: vi.fn() },
    prices: { create: vi.fn() },
    invoices: { pay: vi.fn() },
    coupons: { create: vi.fn() },
    balance: { retrieve: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  };
  return sdk as unknown as Stripe;
}

// Each variant's builder returns the adapter plus a `prime` function that stubs
// the next SDK responses for the two behavioral tests below. Live: stubs the mock SDK.
// Mock: no-op (MockStripeAdapter reads/writes stripe_mock.* directly).
interface AdapterVariant {
  name: string;
  build(): {
    adapter: StripeConnection;
    primeProductCreate: (name: string) => void;
    primeBalanceRetrieve: (amount: number) => void;
    cleanup: () => Promise<void>;
  };
}

const liveVariant: AdapterVariant = {
  name: 'LiveStripeAdapter',
  build() {
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    return {
      adapter,
      primeProductCreate: (name) => {
        (sdk.products.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'prod_contract_stub',
          object: 'product',
          created: Math.floor(Date.now() / 1000),
          name,
          active: true,
          metadata: {},
        });
      },
      primeBalanceRetrieve: (amount) => {
        (sdk.balance.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          object: 'balance',
          available: [{ amount, currency: 'usd' }],
          pending: [],
          livemode: false,
        });
      },
      cleanup: () => Promise.resolve(),
    };
  },
};

const mockVariant: AdapterVariant = {
  name: 'MockStripeAdapter',
  build() {
    return {
      adapter: new MockStripeAdapter(),
      primeProductCreate: () => {},
      primeBalanceRetrieve: () => {},
      async cleanup() {
        const { getPool, closePool } = await import('../../db/pool.js');
        await getPool().query(`DELETE FROM stripe_mock.products WHERE name LIKE $1`, [`%${RUN_TAG}%`]);
        await closePool();
      },
    };
  },
};

// Live variant always runs; mock variant requires RUN_INTEGRATION for DB access.
const variants: AdapterVariant[] = RUN_INTEGRATION ? [liveVariant, mockVariant] : [liveVariant];

for (const variant of variants) {
  describe(`Contract: ${variant.name}`, () => {
    let ctx: ReturnType<AdapterVariant['build']>;

    beforeAll(() => {
      ctx = variant.build();
    });

    afterAll(async () => {
      if (ctx) await ctx.cleanup();
    });

    it('products.create returns a well-formed product with matching name', async () => {
      const name = `Contract Product ${RUN_TAG}`;
      ctx.primeProductCreate(name);
      const result = await ctx.adapter.products.create({ name });
      expect(result.object).toBe('product');
      expect(result.name).toBe(name);
      expect(result.active).toBe(true);
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
      expect(typeof result.created).toBe('number');
    });

    it('balance.retrieve returns a well-formed balance', async () => {
      ctx.primeBalanceRetrieve(500);
      const balance = await ctx.adapter.balance.retrieve();
      expect(balance.object).toBe('balance');
      expect(Array.isArray(balance.available)).toBe(true);
      expect(Array.isArray(balance.pending)).toBe(true);
    });

    it('exposes all 9 facets required by StripeConnection', () => {
      expect(ctx.adapter.balance).toBeDefined();
      expect(ctx.adapter.customers).toBeDefined();
      expect(ctx.adapter.subscriptions).toBeDefined();
      expect(ctx.adapter.subscriptionSchedules).toBeDefined();
      expect(ctx.adapter.products).toBeDefined();
      expect(ctx.adapter.prices).toBeDefined();
      expect(ctx.adapter.invoices).toBeDefined();
      expect(ctx.adapter.coupons).toBeDefined();
      expect(ctx.adapter.webhooks).toBeDefined();
    });
  });
}
