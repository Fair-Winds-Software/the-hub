// Authorized by HUB-1775 (S2 of HUB-1773) — Zod schemas as the single source of truth for
// Stripe response shapes HUB consumes. Both LiveStripeAdapter and MockStripeAdapter validate
// their output through these at the boundary so mock data is structurally identical to live.
// Fields HUB does not read are intentionally omitted (YAGNI); default z.object drops unknown
// keys, forcing us to notice new SDK fields explicitly at the boundary.
//
// Stripe API version pinned to 2026-05-27.dahlia (matches src/stripe/client.ts).
import { z } from 'zod';

// ── Primitives ────────────────────────────────────────────────────────────────

// Stripe uses unix epoch seconds throughout the API.
const StripeTimestamp = z.number().int().nonnegative();

// Stripe returns money amounts as integers in the smallest currency unit (cents for USD).
const StripeAmount = z.number().int();

// ISO 4217 currency, always lowercase in Stripe responses.
const StripeCurrency = z.string().length(3).regex(/^[a-z]{3}$/);

// Stripe object IDs are prefixed by object type. We do not enforce the prefix here — the
// prefix belongs to the mock ID generator (S4) and drift detection at read time.
const StripeId = z.string().min(1);

// ── Balance ───────────────────────────────────────────────────────────────────
// Used by the health probe (balance.retrieve).

const BalanceAmount = z.object({
  amount: StripeAmount,
  currency: StripeCurrency,
});

export const BalanceSchema = z.object({
  object: z.literal('balance'),
  available: z.array(BalanceAmount),
  pending: z.array(BalanceAmount),
  livemode: z.boolean(),
});
export type Balance = z.infer<typeof BalanceSchema>;

// ── Customer ──────────────────────────────────────────────────────────────────
// HUB reads: .id, .email, .metadata

export const CustomerSchema = z.object({
  id: StripeId,
  object: z.literal('customer'),
  created: StripeTimestamp,
  email: z.string().email().nullable().optional(),
  name: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  livemode: z.boolean().optional(),
});
export type Customer = z.infer<typeof CustomerSchema>;

// ── Product ───────────────────────────────────────────────────────────────────
// HUB reads: .id

export const ProductSchema = z.object({
  id: StripeId,
  object: z.literal('product'),
  created: StripeTimestamp,
  name: z.string(),
  active: z.boolean(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type Product = z.infer<typeof ProductSchema>;

// ── Price ─────────────────────────────────────────────────────────────────────
// HUB reads: .id, item.price.id (in subscriptions)

export const PriceRecurringSchema = z.object({
  interval: z.enum(['day', 'week', 'month', 'year']),
  interval_count: z.number().int().positive(),
});

export const PriceSchema = z.object({
  id: StripeId,
  object: z.literal('price'),
  created: StripeTimestamp,
  product: StripeId,
  unit_amount: StripeAmount.nullable(),
  currency: StripeCurrency,
  active: z.boolean(),
  recurring: PriceRecurringSchema.nullable().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type Price = z.infer<typeof PriceSchema>;

// ── Coupon ────────────────────────────────────────────────────────────────────
// HUB reads: .id

export const CouponSchema = z.object({
  id: StripeId,
  object: z.literal('coupon'),
  created: StripeTimestamp,
  name: z.string().nullable().optional(),
  percent_off: z.number().nullable().optional(),
  amount_off: StripeAmount.nullable().optional(),
  currency: StripeCurrency.nullable().optional(),
  duration: z.enum(['forever', 'once', 'repeating']),
  duration_in_months: z.number().int().positive().nullable().optional(),
  valid: z.boolean(),
});
export type Coupon = z.infer<typeof CouponSchema>;

// ── Discount ──────────────────────────────────────────────────────────────────

export const DiscountSchema = z.object({
  id: StripeId,
  object: z.literal('discount'),
  coupon: CouponSchema,
  customer: StripeId.nullable(),
  subscription: StripeId.nullable().optional(),
  start: StripeTimestamp,
  end: StripeTimestamp.nullable(),
});
export type Discount = z.infer<typeof DiscountSchema>;

// ── Subscription ──────────────────────────────────────────────────────────────
// HUB reads: .id, .items.data[].price.id, .status, .current_period_start/end,
//            .cancel_at_period_end, .canceled_at, .customer, .metadata

export const SubscriptionStatus = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

export const SubscriptionItemSchema = z.object({
  id: StripeId,
  object: z.literal('subscription_item'),
  price: PriceSchema,
  quantity: z.number().int().positive().default(1),
});

export const SubscriptionSchema = z.object({
  id: StripeId,
  object: z.literal('subscription'),
  created: StripeTimestamp,
  customer: StripeId,
  status: SubscriptionStatus,
  current_period_start: StripeTimestamp,
  current_period_end: StripeTimestamp,
  cancel_at_period_end: z.boolean(),
  canceled_at: StripeTimestamp.nullable(),
  items: z.object({
    object: z.literal('list'),
    data: z.array(SubscriptionItemSchema),
    has_more: z.boolean().default(false),
  }),
  metadata: z.record(z.string(), z.string()).default({}),
  livemode: z.boolean().optional(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

// ── SubscriptionSchedule ──────────────────────────────────────────────────────
// HUB reads: .id (planChangeService uses schedule.id for updates)

export const SubscriptionSchedulePhaseSchema = z.object({
  start_date: StripeTimestamp,
  end_date: StripeTimestamp.nullable().optional(),
  items: z.array(z.object({
    price: StripeId,
    quantity: z.number().int().positive().default(1),
  })),
});

export const SubscriptionScheduleSchema = z.object({
  id: StripeId,
  object: z.literal('subscription_schedule'),
  created: StripeTimestamp,
  customer: StripeId,
  subscription: StripeId.nullable(),
  status: z.enum(['not_started', 'active', 'completed', 'released', 'canceled']),
  phases: z.array(SubscriptionSchedulePhaseSchema),
  current_phase: z.object({
    start_date: StripeTimestamp,
    end_date: StripeTimestamp,
  }).nullable(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type SubscriptionSchedule = z.infer<typeof SubscriptionScheduleSchema>;

// ── Invoice ───────────────────────────────────────────────────────────────────
// HUB reads: .id, .status, .amount_due, .amount_paid, .currency,
//            .period_start, .period_end, .parent, .lines.data[], .invoice_pdf

export const InvoiceStatus = z.enum([
  'draft',
  'open',
  'paid',
  'uncollectible',
  'void',
]);

export const InvoiceLineItemSchema = z.object({
  id: StripeId,
  object: z.literal('line_item'),
  amount: StripeAmount,
  currency: StripeCurrency,
  description: z.string().nullable().optional(),
  quantity: z.number().int().nonnegative().nullable().optional(),
  price: PriceSchema.nullable().optional(),
  period: z.object({
    start: StripeTimestamp,
    end: StripeTimestamp,
  }).optional(),
});

// invoice.parent replaced legacy invoice.subscription in API 2026-05-27.dahlia; it can be
// null (no parent), a string (subscription ID), or an object with .subscription_details.
export const InvoiceParentSchema = z.union([
  z.null(),
  z.string(),
  z.object({
    type: z.literal('subscription_details'),
    subscription_details: z.object({
      subscription: StripeId,
    }),
  }),
]);

export const InvoiceSchema = z.object({
  id: StripeId,
  object: z.literal('invoice'),
  created: StripeTimestamp,
  customer: StripeId,
  parent: InvoiceParentSchema.optional(),
  status: InvoiceStatus.nullable(),
  amount_due: StripeAmount,
  amount_paid: StripeAmount,
  currency: StripeCurrency,
  period_start: StripeTimestamp,
  period_end: StripeTimestamp,
  invoice_pdf: z.string().url().nullable().optional(),
  lines: z.object({
    object: z.literal('list'),
    data: z.array(InvoiceLineItemSchema),
    has_more: z.boolean().default(false),
  }),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

// ── BalanceTransaction ────────────────────────────────────────────────────────
// Created for customer credit adjustments via customers.createBalanceTransaction.

export const BalanceTransactionSchema = z.object({
  id: StripeId,
  object: z.literal('customer_balance_transaction'),
  created: StripeTimestamp,
  customer: StripeId,
  amount: StripeAmount,
  currency: StripeCurrency,
  description: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type BalanceTransaction = z.infer<typeof BalanceTransactionSchema>;

// ── Pagination envelope ───────────────────────────────────────────────────────
// Generic. Stripe wraps every list response in this shape.

export function paginationEnvelope<T extends z.ZodType>(inner: T) {
  return z.object({
    object: z.literal('list'),
    data: z.array(inner),
    has_more: z.boolean(),
    url: z.string(),
  });
}
export type PaginationEnvelope<T> = {
  object: 'list';
  data: T[];
  has_more: boolean;
  url: string;
};

// ── Error shape ───────────────────────────────────────────────────────────────
// Stripe returns errors in a fixed envelope. mapStripeError in client.ts already handles
// SDK error instances; this schema is for mock error injection and defensive validation.

export const StripeErrorType = z.enum([
  'api_error',
  'card_error',
  'idempotency_error',
  'invalid_request_error',
  'rate_limit_error',
  'authentication_error',
]);

export const StripeErrorShapeSchema = z.object({
  type: StripeErrorType,
  code: z.string().optional(),
  message: z.string(),
  param: z.string().optional(),
  decline_code: z.string().optional(),
  statusCode: z.number().int().min(100).max(599),
});
export type StripeErrorShape = z.infer<typeof StripeErrorShapeSchema>;

// ── Webhook events ────────────────────────────────────────────────────────────
// HUB subscribes to 6 event types via BullMQ queues; each has a specific data.object shape.

// Base envelope shared by all events. The specific event schemas below discriminate on
// event.type and refine event.data.object accordingly.
function webhookEnvelope<T extends z.ZodType>(type: string, object: T) {
  return z.object({
    id: StripeId,
    object: z.literal('event'),
    api_version: z.string(),
    created: StripeTimestamp,
    type: z.literal(type),
    data: z.object({
      object,
      previous_attributes: z.record(z.string(), z.unknown()).optional(),
    }),
    livemode: z.boolean(),
    pending_webhooks: z.number().int().nonnegative().default(0),
  });
}

export const CustomerSubscriptionUpdatedEventSchema = webhookEnvelope(
  'customer.subscription.updated',
  SubscriptionSchema,
);
export const CustomerSubscriptionDeletedEventSchema = webhookEnvelope(
  'customer.subscription.deleted',
  SubscriptionSchema,
);
export const InvoiceCreatedEventSchema = webhookEnvelope('invoice.created', InvoiceSchema);
export const InvoiceFinalizedEventSchema = webhookEnvelope('invoice.finalized', InvoiceSchema);
export const InvoicePaymentSucceededEventSchema = webhookEnvelope(
  'invoice.payment_succeeded',
  InvoiceSchema,
);
export const InvoicePaymentFailedEventSchema = webhookEnvelope(
  'invoice.payment_failed',
  InvoiceSchema,
);

export type CustomerSubscriptionUpdatedEvent = z.infer<typeof CustomerSubscriptionUpdatedEventSchema>;
export type CustomerSubscriptionDeletedEvent = z.infer<typeof CustomerSubscriptionDeletedEventSchema>;
export type InvoiceCreatedEvent = z.infer<typeof InvoiceCreatedEventSchema>;
export type InvoiceFinalizedEvent = z.infer<typeof InvoiceFinalizedEventSchema>;
export type InvoicePaymentSucceededEvent = z.infer<typeof InvoicePaymentSucceededEventSchema>;
export type InvoicePaymentFailedEvent = z.infer<typeof InvoicePaymentFailedEventSchema>;

// Discriminated union of the 6 event types HUB handles. Any Stripe event not in this set
// falls outside HUB's contract and should be dropped at the webhook boundary.
export const HubStripeEventSchema = z.discriminatedUnion('type', [
  CustomerSubscriptionUpdatedEventSchema,
  CustomerSubscriptionDeletedEventSchema,
  InvoiceCreatedEventSchema,
  InvoiceFinalizedEventSchema,
  InvoicePaymentSucceededEventSchema,
  InvoicePaymentFailedEventSchema,
]);
export type HubStripeEvent = z.infer<typeof HubStripeEventSchema>;
