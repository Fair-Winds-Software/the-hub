// Authorized by HUB-1774 (S1 of HUB-1773) — StripeConnection interface. Every Stripe
// operation HUB performs is expressed here, so LiveStripeAdapter (S3) and MockStripeAdapter
// (S4) are interchangeable behind one contract. HUB code depends ONLY on this interface —
// never on the Stripe SDK types or the mock store directly.
//
// Method surface confirmed by grep of `stripe.<obj>.<method>` in src/ at implementation time:
// balance.retrieve, customers.{create, update, createBalanceTransaction, deleteDiscount},
// subscriptions.{create, retrieve, update, cancel},
// subscriptionSchedules.{create, update}, products.create, prices.create, invoices.pay,
// coupons.create, webhooks.constructEvent.
//
// YAGNI: any method not in this list is intentionally excluded. Adding to Stripe's surface
// area is a Story-scoped decision, not a drive-by.
//
// Idempotency: mutations accept an optional idempotencyKey. Live wraps it into the SDK's
// per-request options; mock records it against an idempotency store and short-circuits
// repeats within 24h. HUB uses stripeIdempotencyKey() from client.ts to derive keys.
//
// Timeout + error mapping: withStripeTimeout() and mapStripeError() live in client.ts;
// both adapters apply them internally so callers see AppError, not raw SDK types.
import type {
  Balance,
  BalanceTransaction,
  Coupon,
  Customer,
  Invoice,
  Price,
  Product,
  Subscription,
  SubscriptionSchedule,
} from './schemas.js';

// Signature-verified webhook envelope. constructEvent returns this minimal shape so
// unrecognized event types (charge.succeeded, etc.) still pass through the boundary —
// the webhook receiver's isRecognizedEventType gate + downstream HubStripeEventSchema.parse
// on the stored raw_event handle typed narrowing at their own layer.
export interface VerifiedStripeEvent {
  id: string;
  type: string;
  api_version: string;
  created: number;
  livemode: boolean;
  data: {
    object: unknown;
    previous_attributes?: Record<string, unknown>;
  };
}

// ── Shared options ──────────────────────────────────────────────────────────────

export interface StripeRequestOptions {
  /** Idempotency key for mutations. Live: passed to SDK. Mock: dedup within 24h. */
  idempotencyKey?: string;
}

// ── Input shapes ────────────────────────────────────────────────────────────────
// These mirror the params HUB actually passes today — NOT the full Stripe SDK surface.
// Adding fields here is a Story-scoped decision.

export interface CreateCustomerInput {
  email?: string;
  metadata?: Record<string, string>;
}

export interface UpdateCustomerInput {
  /** Attach a coupon by ID (used by discountService for discount application). */
  coupon?: string;
  metadata?: Record<string, string>;
}

export interface CreateCustomerBalanceTransactionInput {
  /** Positive for debits (customer owes), negative for credits (HUB owes customer). */
  amount: number;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface CreateSubscriptionInput {
  customer: string;
  items: Array<{ price: string; quantity?: number }>;
  metadata?: Record<string, string>;
}

export interface UpdateSubscriptionInput {
  cancel_at_period_end?: boolean;
  items?: Array<{
    id?: string;
    price?: string;
    quantity?: number;
    deleted?: boolean;
  }>;
  metadata?: Record<string, string>;
  proration_behavior?: 'create_prorations' | 'none' | 'always_invoice';
}

export interface CreateSubscriptionScheduleInput {
  from_subscription?: string;
  customer?: string;
  start_date?: number | 'now';
  end_behavior?: 'release' | 'cancel';
  // Phases is optional when from_subscription is provided — Stripe infers phases
  // from the source subscription. Callers pass phases explicitly on greenfield creates.
  phases?: Array<{
    items: Array<{ price?: string; quantity?: number }>;
    iterations?: number;
    proration_behavior?: 'create_prorations' | 'none' | 'always_invoice';
    // Additional per-phase params (start_date, end_date, coupon, price_data, etc.)
    // pass through as unknown; adapter forwards them to the SDK verbatim.
    [key: string]: unknown;
  }>;
  metadata?: Record<string, string>;
}

export interface UpdateSubscriptionScheduleInput {
  phases?: CreateSubscriptionScheduleInput['phases'];
  end_behavior?: 'release' | 'cancel';
  proration_behavior?: 'create_prorations' | 'none' | 'always_invoice';
  metadata?: Record<string, string>;
}

export interface CreateProductInput {
  name: string;
  active?: boolean;
  metadata?: Record<string, string>;
}

export interface CreatePriceInput {
  product: string;
  unit_amount: number;
  currency: string;
  active?: boolean;
  recurring?: {
    interval: 'day' | 'week' | 'month' | 'year';
    interval_count?: number;
  };
  metadata?: Record<string, string>;
}

export interface CreateCouponInput {
  id?: string;
  name?: string;
  percent_off?: number;
  amount_off?: number;
  currency?: string;
  duration: 'forever' | 'once' | 'repeating';
  duration_in_months?: number;
  metadata?: Record<string, string>;
}

// ── Method-group facets ─────────────────────────────────────────────────────────
// Grouped to mirror Stripe's SDK shape so migration diffs stay minimal.

export interface StripeCustomersFacet {
  create(input: CreateCustomerInput, options?: StripeRequestOptions): Promise<Customer>;
  update(id: string, input: UpdateCustomerInput, options?: StripeRequestOptions): Promise<Customer>;
  createBalanceTransaction(
    customerId: string,
    input: CreateCustomerBalanceTransactionInput,
    options?: StripeRequestOptions,
  ): Promise<BalanceTransaction>;
  /** Removes a discount attached to a customer. Returns void per Stripe SDK. */
  deleteDiscount(customerId: string, options?: StripeRequestOptions): Promise<void>;
}

export interface StripeSubscriptionsFacet {
  create(input: CreateSubscriptionInput, options?: StripeRequestOptions): Promise<Subscription>;
  retrieve(id: string, options?: StripeRequestOptions): Promise<Subscription>;
  update(id: string, input: UpdateSubscriptionInput, options?: StripeRequestOptions): Promise<Subscription>;
  cancel(id: string, options?: StripeRequestOptions): Promise<Subscription>;
}

export interface StripeSubscriptionSchedulesFacet {
  create(input: CreateSubscriptionScheduleInput, options?: StripeRequestOptions): Promise<SubscriptionSchedule>;
  update(id: string, input: UpdateSubscriptionScheduleInput, options?: StripeRequestOptions): Promise<SubscriptionSchedule>;
}

export interface StripeProductsFacet {
  create(input: CreateProductInput, options?: StripeRequestOptions): Promise<Product>;
}

export interface StripePricesFacet {
  create(input: CreatePriceInput, options?: StripeRequestOptions): Promise<Price>;
}

export interface StripeInvoicesFacet {
  pay(id: string, options?: StripeRequestOptions): Promise<Invoice>;
}

export interface StripeCouponsFacet {
  create(input: CreateCouponInput, options?: StripeRequestOptions): Promise<Coupon>;
}

export interface StripeBalanceFacet {
  /** Used by the health probe; also served by MockStripeAdapter for parity. */
  retrieve(options?: StripeRequestOptions): Promise<Balance>;
}

export interface StripeWebhooksFacet {
  /**
   * Verifies a webhook signature and returns the decoded event.
   * Live: delegates to Stripe SDK webhooks.constructEvent().
   * Mock: returns a synthetic event only if the caller supplied a matching signature
   * from the mock signer (used by contract tests); otherwise throws.
   *
   * Returns a signature-verified envelope; typed narrowing via HubStripeEventSchema.parse
   * happens downstream (queue processors read raw_event JSON and validate against the
   * discriminated union then). This keeps the boundary honest about what verify actually
   * does — verify signature and decode JSON.
   */
  constructEvent(
    payload: string | Buffer,
    signatureHeader: string,
    secret: string,
  ): VerifiedStripeEvent;
}

// ── Top-level interface ─────────────────────────────────────────────────────────
// HUB-1794 (S5 of HUB-1783): StripeConnection now extends ExternalConnection so the
// LiveStripeAdapter / MockStripeAdapter implementations satisfy the generic base +
// register with the multi-connection registry alongside future connections.

import type { ExternalConnection } from '../connections/base.js';

export interface StripeConnection extends ExternalConnection {
  readonly balance: StripeBalanceFacet;
  readonly customers: StripeCustomersFacet;
  readonly subscriptions: StripeSubscriptionsFacet;
  readonly subscriptionSchedules: StripeSubscriptionSchedulesFacet;
  readonly products: StripeProductsFacet;
  readonly prices: StripePricesFacet;
  readonly invoices: StripeInvoicesFacet;
  readonly coupons: StripeCouponsFacet;
  readonly webhooks: StripeWebhooksFacet;
}
