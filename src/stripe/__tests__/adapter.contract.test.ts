// Authorized by HUB-1777 (S4 of HUB-1773) — contract test harness. Runs the SAME
// behavioral suite against both LiveStripeAdapter (SDK mocked) and MockStripeAdapter
// (against stripe_mock.*). Proves the two adapters satisfy the StripeConnection
// interface identically at the observable-behavior layer, which is the guarantee HUB
// callers depend on when swapping adapters via the S8 registry.
//
// Authorized by HUB-1796 (S7 of HUB-1783) — refactored to a thin caller. The
// ExternalConnection portion of the contract (name / mode / probe) now runs via the
// shared harness at `src/connections/__tests__/contractHarness.ts` so future
// connections plug in without duplicating this scaffolding. Stripe-specific behavior
// (products.create shape, balance.retrieve shape, the 9 domain facets) stays here.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type Stripe from 'stripe';
import { LiveStripeAdapter } from '../liveAdapter.js';
import { MockStripeAdapter } from '../mockAdapter.js';
import type { StripeConnection } from '../connection.js';
import { runExternalConnectionContract, type AdapterVariant } from '../../connections/__tests__/contractHarness.js';
import {
  registerConnection,
  _resetConnectionsRegistryForTest,
  _setConnectionModeForTest,
} from '../../connections/registry.js';
import { _resetStripeRegistryForTest } from '../registry.js';

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
// the next SDK responses for the behavioral tests below. Live: stubs the mock SDK.
// Mock: no-op (MockStripeAdapter reads/writes stripe_mock.* directly).
interface StripeVariant extends AdapterVariant<StripeConnection> {
  build(): {
    adapter: StripeConnection;
    primeProbeOk?: () => void;
    primeProductCreate: (name: string) => void;
    primeBalanceRetrieve: (amount: number) => void;
    cleanup: () => Promise<void>;
  };
}

const liveVariant: StripeVariant = {
  name: 'LiveStripeAdapter',
  build() {
    const sdk = makeSdkMock();
    const adapter = new LiveStripeAdapter(sdk);
    const primeBalance = (amount: number): void => {
      (sdk.balance.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        object: 'balance',
        available: [{ amount, currency: 'usd' }],
        pending: [],
        livemode: false,
      });
    };
    return {
      adapter,
      // The shared harness's probe() test uses this to stub balance.retrieve so
      // LiveStripeAdapter.probe() (which delegates to balance.retrieve) resolves ok.
      primeProbeOk: () => primeBalance(0),
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
      primeBalanceRetrieve: primeBalance,
      cleanup: () => Promise.resolve(),
    };
  },
};

const mockVariant: StripeVariant = {
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
const variants: StripeVariant[] = RUN_INTEGRATION ? [liveVariant, mockVariant] : [liveVariant];

// ── Shared ExternalConnection contract (runs via the S7 harness) ────────────────
// LiveStripeAdapter.mode() reads getConnectionMode('stripe') from the S2 registry,
// so we register Stripe explicitly (with adapter factories that will never actually
// run — the harness receives already-built adapters) before the harness's mode()
// test runs, then force the mode to 'mock' so no live-cred check fires.
_resetConnectionsRegistryForTest();
_resetStripeRegistryForTest();
registerConnection({
  name: 'stripe',
  buildLive: () => variants[0]!.build().adapter,
  buildMock: () => variants[0]!.build().adapter,
  hasLiveCredentials: () => true,
});
_setConnectionModeForTest('stripe', 'mock');

runExternalConnectionContract(variants);

// ── Stripe-specific behavioral tests ────────────────────────────────────────────

for (const variant of variants) {
  describe(`Stripe-specific contract: ${variant.name}`, () => {
    let ctx: ReturnType<StripeVariant['build']>;

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
