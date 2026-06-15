// Authorized by HUB-127 — queue registry; getAllQueueDefinitions() consumed by worker scaffold
// Authorized by HUB-644 — margin-review queue; periodic_margin_review CRON processor
// Authorized by HUB-643 — alerts queue; below_floor BullMQ event publication
// Authorized by HUB-146 — queue factory pattern; concrete queue definitions registered here
// Authorized by HUB-189 — stripe-event queue for webhook dispatch
// Authorized by HUB-202 — event-type-specific queue routing; hasQueueForEventType / getQueueForEventType
// Authorized by HUB-203 — isRecognizedEventType() pre-INSERT gate; unrecognized events not stored
// Authorized by HUB-272 — license-check queue processor; routes promote_staged_license_changes jobs
// Authorized by HUB-336 — batch-sweep queue processor; routes sdk-version-retention-cron jobs
// Authorized by HUB-429 — customer.subscription.updated/deleted event-type queues; E10 subscription processing
// Authorized by HUB-475 — invoice event-type queues + billing-payment-failed queue; E11 invoice processing
// Authorized by HUB-504 — billing-payment-failed processor; routes to billingFreezeService.handleBillingPaymentFailed
// Authorized by HUB-517 — grace-period-expiry-scanner queue; CRON-driven expiry resolution
import { Queue } from 'bullmq';
import type { ConnectionOptions, BackoffOptions, Job, JobsOptions } from 'bullmq';
import { getRedisClient } from '../redis/client.js';

type JobProcessor = (job: Job) => Promise<void>;

export interface QueueDefinition {
  name: string;
  concurrency: number;
  maxAttempts?: number;
  backoff?: BackoffOptions;
  deadLetterQueue?: string;
  processor?: JobProcessor;
}

// Queue instance registry — prevents duplicate BullMQ connections per queue name
const _queueInstances = new Map<string, Queue>();

// Queue definitions registry — consumed by worker scaffold (HUB-127)
const _queues: QueueDefinition[] = [];

export function getAllQueueDefinitions(): QueueDefinition[] {
  return [..._queues];
}

export function registerQueue(def: QueueDefinition): void {
  _queues.push(def);
}

// Returns default BullMQ job options derived from a queue definition
export function defaultJobOptions(def: Pick<QueueDefinition, 'maxAttempts' | 'backoff'>): JobsOptions {
  return {
    attempts: def.maxAttempts,
    backoff: def.backoff,
  };
}

function getOrCreateQueue(name: string, connection?: ConnectionOptions): Queue {
  const existing = _queueInstances.get(name);
  if (existing) return existing;
  // Cast required: BullMQ bundles its own ioredis version; same pattern as worker.ts
  const conn = connection ?? (getRedisClient() as unknown as ConnectionOptions);
  const q = new Queue(name, { connection: conn });
  _queueInstances.set(name, q);
  return q;
}

// ── Concrete Queue Definitions ──────────────────────────────────────────────
// Names are prefixed `queue:` so Redis keys become `hub:queue:<name>:*` via
// the `hub:` keyPrefix already set on the ioredis client (HUB-125).

export const DLQ_QUEUE_NAME = 'queue:dlq';

// Sentinel entry — no processor; worker skips it. Jobs land here via failed-event handler.
const DLQ_DEF: QueueDefinition = {
  name: DLQ_QUEUE_NAME,
  concurrency: 0,
};

const STRIPE_EVENT_DEF: QueueDefinition = {
  name: 'queue:stripe-event',
  concurrency: 5,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
};

const BATCH_SWEEP_DEF: QueueDefinition = {
  name: 'queue:batch-sweep',
  concurrency: 2,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    if (job.name === 'sdk-version-retention-cron') {
      const { pruneOldVersionReports } = await import('../services/versionReporting.js');
      await pruneOldVersionReports();
    }
  },
};

const LICENSE_CHECK_DEF: QueueDefinition = {
  name: 'queue:license-check',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  // Dynamic import avoids loading the full service layer at module evaluation time;
  // only loaded when the worker actually picks up a job.
  processor: async (job: Job) => {
    if (job.name === 'promote_staged_license_changes') {
      const { promoteStagedLicenseChanges } = await import('../services/license.js');
      await promoteStagedLicenseChanges();
    }
  },
};

// ── Queue Factories ─────────────────────────────────────────────────────────

export function getStripeEventQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(STRIPE_EVENT_DEF.name, connection);
}

export function getBatchSweepQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(BATCH_SWEEP_DEF.name, connection);
}

export function getLicenseCheckQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(LICENSE_CHECK_DEF.name, connection);
}

export function getDlqQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(DLQ_DEF.name, connection);
}

// Returns true if a queue definition for hub:queue:stripe:[eventType] is registered.
// E10–E12 billing Epics call registerQueue() to make their event-type queues discoverable here.
export function hasQueueForEventType(eventType: string): boolean {
  return _queues.some((q) => q.name === `queue:stripe:${eventType}`);
}

// Semantic alias for the pre-INSERT recognized-type gate (HUB-203).
// Distinguishes "does this event type have ANY registered factory" from the routing
// decision in getQueueForEventType (which is about specific vs DLQ queue selection).
export function isRecognizedEventType(eventType: string): boolean {
  return hasQueueForEventType(eventType);
}

// Returns the registered event-type queue, or the DLQ if no factory is registered.
// Callers are responsible for logging before invoking when they detect a fallback route.
export function getQueueForEventType(eventType: string): Queue {
  const queueName = `queue:stripe:${eventType}`;
  return hasQueueForEventType(eventType) ? getOrCreateQueue(queueName) : getDlqQueue();
}

const SUBSCRIPTION_UPDATED_DEF: QueueDefinition = {
  name: 'queue:stripe:customer.subscription.updated',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    const { handleSubscriptionUpdated } = await import('../services/stripeService.js');
    await handleSubscriptionUpdated(job.data.event_id as string);
  },
};

const SUBSCRIPTION_DELETED_DEF: QueueDefinition = {
  name: 'queue:stripe:customer.subscription.deleted',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    const { handleSubscriptionDeleted } = await import('../services/stripeService.js');
    await handleSubscriptionDeleted(job.data.event_id as string);
  },
};

// ── E11 Invoice event queues ──────────────────────────────────────────────────

const INVOICE_CREATED_DEF: QueueDefinition = {
  name: 'queue:stripe:invoice.created',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    const { handleInvoiceCreated } = await import('../services/invoiceService.js');
    await handleInvoiceCreated(job.data.event_id as string);
  },
};

const INVOICE_FINALIZED_DEF: QueueDefinition = {
  name: 'queue:stripe:invoice.finalized',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    const { handleInvoiceFinalized } = await import('../services/invoiceService.js');
    await handleInvoiceFinalized(job.data.event_id as string);
  },
};

const INVOICE_PAYMENT_SUCCEEDED_DEF: QueueDefinition = {
  name: 'queue:stripe:invoice.payment_succeeded',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    const { handleInvoicePaymentSucceeded } = await import('../services/invoiceService.js');
    await handleInvoicePaymentSucceeded(job.data.event_id as string);
  },
};

const INVOICE_PAYMENT_FAILED_DEF: QueueDefinition = {
  name: 'queue:stripe:invoice.payment_failed',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    const { handleInvoicePaymentFailed } = await import('../services/invoiceService.js');
    await handleInvoicePaymentFailed(job.data.event_id as string);
  },
};

// Downstream queue: receives billing_payment_failed jobs enqueued by handleInvoicePaymentFailed.
// Not an event-type queue — not discoverable via isRecognizedEventType().
const BILLING_PAYMENT_FAILED_DEF: QueueDefinition = {
  name: 'queue:billing-payment-failed',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    const { handleBillingPaymentFailed } = await import('../services/billingFreezeService.js');
    await handleBillingPaymentFailed(job.data.stripe_invoice_id as string);
  },
};

export function getBillingPaymentFailedQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(BILLING_PAYMENT_FAILED_DEF.name, connection);
}

// Grace period expiry scanner: CRON-driven scan for expired open grace periods.
const GRACE_PERIOD_EXPIRY_SCANNER_DEF: QueueDefinition = {
  name: 'queue:grace-period-expiry-scanner',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (_job: Job) => {
    const { scanAndResolveExpiredGracePeriods } = await import('../services/billingFreezeService.js');
    await scanAndResolveExpiredGracePeriods();
  },
};

export function getGracePeriodExpiryScannerQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(GRACE_PERIOD_EXPIRY_SCANNER_DEF.name, connection);
}

// Alerts queue: receives below_floor events from E15 evaluateMargin(); consumed by I-5 (E18+)
const ALERTS_DEF: QueueDefinition = {
  name: 'queue:alerts:below_floor',
  concurrency: 0, // publisher only at E15; worker registered by I-5 (E18+)
};

export function getAlertsQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(ALERTS_DEF.name, connection);
}

// Margin review queue: daily CRON triggers evaluateMargin() for all enabled configs
const MARGIN_REVIEW_DEF: QueueDefinition = {
  name: 'queue:margin-review',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (_job: Job) => {
    const { runPeriodicMarginReview } = await import('./marginReviewJob.js');
    await runPeriodicMarginReview();
  },
};

export function getMarginReviewQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(MARGIN_REVIEW_DEF.name, connection);
}

// Register concrete queues — worker scaffold discovers these at startup via getAllQueueDefinitions()
registerQueue(STRIPE_EVENT_DEF);
registerQueue(BATCH_SWEEP_DEF);
registerQueue(LICENSE_CHECK_DEF);
// E10 subscription event queues — must be registered for isRecognizedEventType() to pass
registerQueue(SUBSCRIPTION_UPDATED_DEF);
registerQueue(SUBSCRIPTION_DELETED_DEF);
// E11 invoice event queues — must be registered for isRecognizedEventType() to pass
registerQueue(INVOICE_CREATED_DEF);
registerQueue(INVOICE_FINALIZED_DEF);
registerQueue(INVOICE_PAYMENT_SUCCEEDED_DEF);
registerQueue(INVOICE_PAYMENT_FAILED_DEF);
registerQueue(BILLING_PAYMENT_FAILED_DEF);
// E12 grace period expiry scanner
registerQueue(GRACE_PERIOD_EXPIRY_SCANNER_DEF);
// E15 alerts publisher + margin review CRON
registerQueue(ALERTS_DEF);
registerQueue(MARGIN_REVIEW_DEF);
// DLQ registered last; processor-less sentinel — worker skips it, ops investigate manually
registerQueue(DLQ_DEF);
