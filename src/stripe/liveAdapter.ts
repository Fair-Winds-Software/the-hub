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
import { getStripe, mapStripeError, withStripeTimeout } from './client.js';
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

// Runs an SDK call under timeout + error mapping, then validates the response through Zod.
// On schema drift we log the raw shape via AppError.message so drift is diagnosable.
// Uses the schema type itself as generic so z.infer gives us the correct OUTPUT type
// (fields with .default() become non-optional post-parse).
async function callAndValidate<S extends z.ZodTypeAny>(
  schema: S,
  fn: () => Promise<unknown>,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await withStripeTimeout(fn);
  } catch (err) {
    // mapStripeError throws — cast to never satisfies the type checker.
    mapStripeError(err);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      502,
      `Stripe response schema drift: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
    );
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
  constructor(private readonly sdk: Stripe) {}

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
      await withStripeTimeout(() =>
        this.sdk.customers.deleteDiscount(customerId, toSdkRequestOptions(options)),
      );
    } catch (err) {
      mapStripeError(err);
    }
  }
}

class LiveSubscriptionsFacet implements StripeSubscriptionsFacet {
  constructor(private readonly sdk: Stripe) {}

  create(input: CreateSubscriptionInput, options?: StripeRequestOptions): Promise<Subscription> {
    return callAndValidate(SubscriptionSchema, () =>
      this.sdk.subscriptions.create(input as Stripe.SubscriptionCreateParams, toSdkRequestOptions(options)),
    );
  }

  retrieve(id: string, options?: StripeRequestOptions): Promise<Subscription> {
    return callAndValidate(SubscriptionSchema, () =>
      this.sdk.subscriptions.retrieve(id, undefined, toSdkRequestOptions(options)),
    );
  }

  update(id: string, input: UpdateSubscriptionInput, options?: StripeRequestOptions): Promise<Subscription> {
    return callAndValidate(SubscriptionSchema, () =>
      this.sdk.subscriptions.update(id, input as Stripe.SubscriptionUpdateParams, toSdkRequestOptions(options)),
    );
  }

  cancel(id: string, options?: StripeRequestOptions): Promise<Subscription> {
    return callAndValidate(SubscriptionSchema, () =>
      this.sdk.subscriptions.cancel(id, undefined, toSdkRequestOptions(options)),
    );
  }
}

class LiveSubscriptionSchedulesFacet implements StripeSubscriptionSchedulesFacet {
  constructor(private readonly sdk: Stripe) {}

  create(
    input: CreateSubscriptionScheduleInput,
    options?: StripeRequestOptions,
  ): Promise<SubscriptionSchedule> {
    return callAndValidate(SubscriptionScheduleSchema, () =>
      this.sdk.subscriptionSchedules.create(
        input as Stripe.SubscriptionScheduleCreateParams,
        toSdkRequestOptions(options),
      ),
    );
  }

  update(
    id: string,
    input: UpdateSubscriptionScheduleInput,
    options?: StripeRequestOptions,
  ): Promise<SubscriptionSchedule> {
    return callAndValidate(SubscriptionScheduleSchema, () =>
      this.sdk.subscriptionSchedules.update(
        id,
        input as Stripe.SubscriptionScheduleUpdateParams,
        toSdkRequestOptions(options),
      ),
    );
  }
}

class LiveProductsFacet implements StripeProductsFacet {
  constructor(private readonly sdk: Stripe) {}

  create(input: CreateProductInput, options?: StripeRequestOptions): Promise<Product> {
    return callAndValidate(ProductSchema, () =>
      this.sdk.products.create(input, toSdkRequestOptions(options)),
    );
  }
}

class LivePricesFacet implements StripePricesFacet {
  constructor(private readonly sdk: Stripe) {}

  create(input: CreatePriceInput, options?: StripeRequestOptions): Promise<Price> {
    return callAndValidate(PriceSchema, () =>
      this.sdk.prices.create(input as Stripe.PriceCreateParams, toSdkRequestOptions(options)),
    );
  }
}

class LiveInvoicesFacet implements StripeInvoicesFacet {
  constructor(private readonly sdk: Stripe) {}

  pay(id: string, options?: StripeRequestOptions): Promise<Invoice> {
    return callAndValidate(InvoiceSchema, () =>
      this.sdk.invoices.pay(id, undefined, toSdkRequestOptions(options)),
    );
  }
}

class LiveCouponsFacet implements StripeCouponsFacet {
  constructor(private readonly sdk: Stripe) {}

  create(input: CreateCouponInput, options?: StripeRequestOptions): Promise<Coupon> {
    return callAndValidate(CouponSchema, () =>
      this.sdk.coupons.create(input as Stripe.CouponCreateParams, toSdkRequestOptions(options)),
    );
  }
}

class LiveBalanceFacet implements StripeBalanceFacet {
  constructor(private readonly sdk: Stripe) {}

  retrieve(options?: StripeRequestOptions): Promise<Balance> {
    return callAndValidate(BalanceSchema, () =>
      this.sdk.balance.retrieve(undefined, toSdkRequestOptions(options)),
    );
  }
}

class LiveWebhooksFacet implements StripeWebhooksFacet {
  constructor(private readonly sdk: Stripe) {}

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

  constructor(sdk: Stripe = getStripe()) {
    this.balance = new LiveBalanceFacet(sdk);
    this.customers = new LiveCustomersFacet(sdk);
    this.subscriptions = new LiveSubscriptionsFacet(sdk);
    this.subscriptionSchedules = new LiveSubscriptionSchedulesFacet(sdk);
    this.products = new LiveProductsFacet(sdk);
    this.prices = new LivePricesFacet(sdk);
    this.invoices = new LiveInvoicesFacet(sdk);
    this.coupons = new LiveCouponsFacet(sdk);
    this.webhooks = new LiveWebhooksFacet(sdk);
  }
}
