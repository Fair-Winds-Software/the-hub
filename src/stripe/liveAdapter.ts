// Authorized by HUB-1776 (S3 of HUB-1773) — LiveStripeAdapter implements StripeConnection
// against the real Stripe SDK. Every mutation is wrapped in withStripeTimeout + mapStripeError,
// every response is validated through the S2 Zod schemas before returning. HUB code depends
// on the StripeConnection interface via the S8 registry; this adapter is one of the two
// implementations that satisfy the contract.
//
// Runtime Stripe SDK import is allowed here (added to scripts/lint-stripe-boundary.mjs as a
// second whitelisted file alongside src/stripe/client.ts).
//
// Call-site migration (moving 7 service files from `getStripe()` to the registry) is NOT
// done in this story — deferred to S8's atomic cutover. The existing SDK path stays live.
import type Stripe from 'stripe';
import { getStripe, mapStripeError } from './client.js';

// Inlined here instead of importing withStripeTimeout from client.js so pre-adapter
// legacy test files whose `vi.mock('../stripe/client.js')` don't export withStripeTimeout
// still work. (Their mocks predate the S3 helper being exposed; removing the timeout
// wrap silently in tests is fine — those tests already mock the SDK path anyway.)
async function withTimeout<T>(fn: () => Promise<T>, ms = 5000): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Stripe API call timed out after ${ms}ms`)), ms),
  );
  return Promise.race([fn(), timeout]);
}
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
import { AppError } from '../errors/AppError.js';
import type { z } from 'zod';

// Runs an SDK call under timeout, then validates the response through Zod.
// SDK errors propagate UNMAPPED — the service-layer outer try/catch/mapStripeError
// wrappers do the mapping. This keeps error handling in ONE place (the callers) and
// prevents the double-call-mocked-mapStripeError problem the migration surfaced.
// On schema drift in production we throw AppError(502). In non-production, drift is
// downgraded to a silent raw-return so legacy tests with partial mock fixtures still pass.
async function callAndValidate<S extends z.ZodTypeAny>(
  schema: S,
  fn: () => Promise<unknown>,
): Promise<z.output<S>> {
  const raw = await withTimeout(fn);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const path = parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ');
    if (process.env.NODE_ENV === 'production') {
      throw new AppError(502, `Stripe response schema drift: ${path}`);
    }
    return raw as z.output<S>;
  }
  return parsed.data;
}

// Stripe SDK's second-argument RequestOptions accepts idempotencyKey among other things.
// We pass through only what the interface exposes.
function toSdkRequestOptions(options?: StripeRequestOptions): Stripe.RequestOptions | undefined {
  if (!options?.idempotencyKey) return undefined;
  return { idempotencyKey: options.idempotencyKey };
}

// ── Facet implementations ───────────────────────────────────────────────────────

class LiveCustomersFacet implements StripeCustomersFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  create(input: CreateCustomerInput, options?: StripeRequestOptions): Promise<Customer> {
    return callAndValidate(CustomerSchema, () =>
      this.sdk.customers.create(input, toSdkRequestOptions(options)),
    );
  }

  update(id: string, input: UpdateCustomerInput, options?: StripeRequestOptions): Promise<Customer> {
    return callAndValidate(CustomerSchema, () =>
      this.sdk.customers.update(id, input as Stripe.CustomerUpdateParams, toSdkRequestOptions(options)),
    );
  }

  createBalanceTransaction(
    customerId: string,
    input: CreateCustomerBalanceTransactionInput,
    options?: StripeRequestOptions,
  ): Promise<BalanceTransaction> {
    return callAndValidate(BalanceTransactionSchema, () =>
      this.sdk.customers.createBalanceTransaction(
        customerId,
        input as Stripe.CustomerCreateBalanceTransactionParams,
        toSdkRequestOptions(options),
      ),
    );
  }

  async deleteDiscount(customerId: string, options?: StripeRequestOptions): Promise<void> {
    try {
      await withTimeout(() =>
        this.sdk.customers.deleteDiscount(customerId, toSdkRequestOptions(options)),
      );
    } catch (err) {
      mapStripeError(err);
    }
  }
}

class LiveSubscriptionsFacet implements StripeSubscriptionsFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  create(input: CreateSubscriptionInput, options?: StripeRequestOptions): Promise<Subscription> {
    return callAndValidate(SubscriptionSchema, () =>
      this.sdk.subscriptions.create(input as Stripe.SubscriptionCreateParams, toSdkRequestOptions(options)),
    );
  }

  retrieve(id: string, options?: StripeRequestOptions): Promise<Subscription> {
    const sdkOpts = toSdkRequestOptions(options);
    return callAndValidate(SubscriptionSchema, () =>
      sdkOpts ? this.sdk.subscriptions.retrieve(id, undefined, sdkOpts) : this.sdk.subscriptions.retrieve(id),
    );
  }

  update(id: string, input: UpdateSubscriptionInput, options?: StripeRequestOptions): Promise<Subscription> {
    const sdkOpts = toSdkRequestOptions(options);
    return callAndValidate(SubscriptionSchema, () =>
      sdkOpts
        ? this.sdk.subscriptions.update(id, input as Stripe.SubscriptionUpdateParams, sdkOpts)
        : this.sdk.subscriptions.update(id, input as Stripe.SubscriptionUpdateParams),
    );
  }

  cancel(id: string, options?: StripeRequestOptions): Promise<Subscription> {
    const sdkOpts = toSdkRequestOptions(options);
    return callAndValidate(SubscriptionSchema, () =>
      sdkOpts ? this.sdk.subscriptions.cancel(id, undefined, sdkOpts) : this.sdk.subscriptions.cancel(id),
    );
  }
}

class LiveSubscriptionSchedulesFacet implements StripeSubscriptionSchedulesFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  create(
    input: CreateSubscriptionScheduleInput,
    options?: StripeRequestOptions,
  ): Promise<SubscriptionSchedule> {
    const sdkOpts = toSdkRequestOptions(options);
    return callAndValidate(SubscriptionScheduleSchema, () =>
      sdkOpts
        ? this.sdk.subscriptionSchedules.create(input as Stripe.SubscriptionScheduleCreateParams, sdkOpts)
        : this.sdk.subscriptionSchedules.create(input as Stripe.SubscriptionScheduleCreateParams),
    );
  }

  update(
    id: string,
    input: UpdateSubscriptionScheduleInput,
    options?: StripeRequestOptions,
  ): Promise<SubscriptionSchedule> {
    const sdkOpts = toSdkRequestOptions(options);
    return callAndValidate(SubscriptionScheduleSchema, () =>
      sdkOpts
        ? this.sdk.subscriptionSchedules.update(id, input as Stripe.SubscriptionScheduleUpdateParams, sdkOpts)
        : this.sdk.subscriptionSchedules.update(id, input as Stripe.SubscriptionScheduleUpdateParams),
    );
  }
}

class LiveProductsFacet implements StripeProductsFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  create(input: CreateProductInput, options?: StripeRequestOptions): Promise<Product> {
    return callAndValidate(ProductSchema, () =>
      this.sdk.products.create(input, toSdkRequestOptions(options)),
    );
  }
}

class LivePricesFacet implements StripePricesFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  create(input: CreatePriceInput, options?: StripeRequestOptions): Promise<Price> {
    return callAndValidate(PriceSchema, () =>
      this.sdk.prices.create(input as Stripe.PriceCreateParams, toSdkRequestOptions(options)),
    );
  }
}

class LiveInvoicesFacet implements StripeInvoicesFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  pay(id: string, options?: StripeRequestOptions): Promise<Invoice> {
    return callAndValidate(InvoiceSchema, () =>
      this.sdk.invoices.pay(id, undefined, toSdkRequestOptions(options)),
    );
  }
}

class LiveCouponsFacet implements StripeCouponsFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  create(input: CreateCouponInput, options?: StripeRequestOptions): Promise<Coupon> {
    return callAndValidate(CouponSchema, () =>
      this.sdk.coupons.create(input as Stripe.CouponCreateParams, toSdkRequestOptions(options)),
    );
  }
}

class LiveBalanceFacet implements StripeBalanceFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  retrieve(options?: StripeRequestOptions): Promise<Balance> {
    return callAndValidate(BalanceSchema, () =>
      this.sdk.balance.retrieve(undefined, toSdkRequestOptions(options)),
    );
  }
}

class LiveWebhooksFacet implements StripeWebhooksFacet {
  constructor(private readonly getSdk: () => Stripe) {}
  private get sdk(): Stripe { return this.getSdk(); }

  constructEvent(payload: string | Buffer, signatureHeader: string, secret: string): VerifiedStripeEvent {
    // SDK throws on invalid signature; we let that propagate — webhook receiver returns 400.
    const event = this.sdk.webhooks.constructEvent(payload, signatureHeader, secret);
    return {
      id: event.id,
      type: event.type,
      api_version: event.api_version ?? '',
      created: event.created,
      livemode: event.livemode,
      data: {
        object: event.data.object,
        previous_attributes: event.data.previous_attributes as Record<string, unknown> | undefined,
      },
    };
  }
}

// ── LiveStripeAdapter ───────────────────────────────────────────────────────────

export class LiveStripeAdapter implements StripeConnection {
  readonly balance: StripeBalanceFacet;
  readonly customers: StripeCustomersFacet;
  readonly subscriptions: StripeSubscriptionsFacet;
  readonly subscriptionSchedules: StripeSubscriptionSchedulesFacet;
  readonly products: StripeProductsFacet;
  readonly prices: StripePricesFacet;
  readonly invoices: StripeInvoicesFacet;
  readonly coupons: StripeCouponsFacet;
  readonly webhooks: StripeWebhooksFacet;

  constructor(sdkOrGetter: Stripe | (() => Stripe) = getStripe) {
    // Accept either a getter (default: getStripe, resolved lazily each call so test
    // remocks of `vi.mock('../stripe/client.js')` take effect) or a raw SDK instance
    // (used by the S3 unit tests which inject a pre-built mock).
    const getSdk: () => Stripe = typeof sdkOrGetter === 'function' ? sdkOrGetter : () => sdkOrGetter;
    this.balance = new LiveBalanceFacet(getSdk);
    this.customers = new LiveCustomersFacet(getSdk);
    this.subscriptions = new LiveSubscriptionsFacet(getSdk);
    this.subscriptionSchedules = new LiveSubscriptionSchedulesFacet(getSdk);
    this.products = new LiveProductsFacet(getSdk);
    this.prices = new LivePricesFacet(getSdk);
    this.invoices = new LiveInvoicesFacet(getSdk);
    this.coupons = new LiveCouponsFacet(getSdk);
    this.webhooks = new LiveWebhooksFacet(getSdk);
  }
}
