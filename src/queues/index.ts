// Authorized by HUB-127 — queue registry; getAllQueueDefinitions() consumed by worker scaffold
// Authorized by HUB-1523 — BullMQ retention policy: removeOnComplete (7d) + removeOnFail (30d) on all queues
// Authorized by HUB-1524 — retention:monthly queue for audit_log + cost_ledger pruning CRON
// Authorized by HUB-644 — margin-review queue; periodic_margin_review CRON processor
// Authorized by HUB-1043 — compliance-evaluation queue; daily CRON evaluation runner
// Authorized by HUB-643 — alerts queue; below_floor BullMQ event publication
// Authorized by HUB-672 — period-cost-aggregation queue; monthly billing period cost aggregation
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
// Authorized by HUB-719 — alert source queues for grace_period_expired, payment_failed, sdk_version_deprecated
// Authorized by HUB-707 — notifications deliver queue; hub:queue:notifications:deliver; consumed by E19
// Authorized by HUB-787 — escalation scanner queue; CRON-driven scan every 5 minutes; consumed by E20
// Authorized by HUB-808 — escalation deliver queue; contact fan-out; 3-retry DLQ policy
// Authorized by HUB-829 — workflow hook delivery queue; event-driven; 3-retry DLQ policy
// Authorized by HUB-1354 — human-escalation queue; daily CRON human overdue reminder scheduler
// Authorized by HUB-1355 — drift-detection queue; daily CRON posture score drift detector
// Authorized by HUB-1145 — plan-advisor queue; weekly CRON advisor engine for all active product/tenant pairs
// Authorized by HUB-1489 — billing-jobs queue; grandfather-subscribers + confirm-plan-change processors
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

// Applied to every Queue at construction time — prevents unbounded Redis growth.
const QUEUE_RETENTION_OPTIONS = {
  removeOnComplete: { age: 604800 },  // 7 days in seconds
  removeOnFail: { age: 2592000 },     // 30 days in seconds
} as const;

function getOrCreateQueue(name: string, connection?: ConnectionOptions): Queue {
  const existing = _queueInstances.get(name);
  if (existing) return existing;
  // Cast required: BullMQ bundles its own ioredis version; same pattern as worker.ts
  const conn = connection ?? (getRedisClient() as unknown as ConnectionOptions);
  const q = new Queue(name, {
    connection: conn,
    defaultJobOptions: QUEUE_RETENTION_OPTIONS,
  });
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

// Alert source queues registered by E18 — consumed by registerAlertHandlers() workers (HUB-719)
const GRACE_PERIOD_EXPIRED_ALERTS_DEF: QueueDefinition = {
  name: 'queue:alerts:grace_period_expired',
  concurrency: 0,
};

export function getGracePeriodExpiredAlertsQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(GRACE_PERIOD_EXPIRED_ALERTS_DEF.name, connection);
}

const PAYMENT_FAILED_ALERTS_DEF: QueueDefinition = {
  name: 'queue:alerts:payment_failed',
  concurrency: 0,
};

export function getPaymentFailedAlertsQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(PAYMENT_FAILED_ALERTS_DEF.name, connection);
}

const SDK_VERSION_DEPRECATED_ALERTS_DEF: QueueDefinition = {
  name: 'queue:alerts:sdk_version_deprecated',
  concurrency: 0,
};

export function getSdkVersionDeprecatedAlertsQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(SDK_VERSION_DEPRECATED_ALERTS_DEF.name, connection);
}

// Notifications delivery queue: receives jobs from ingestAlert(); consumed by E19 deliver worker (HUB-707)
const NOTIFICATIONS_DELIVER_DEF: QueueDefinition = {
  name: 'queue:notifications:deliver',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
};

export function getNotificationsDeliverQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(NOTIFICATIONS_DELIVER_DEF.name, connection);
}

// Escalation scanner queue: receives CRON-triggered jobs; consumed by registerEscalationScannerJob() worker (HUB-787)
const ESCALATION_SCANNER_DEF: QueueDefinition = {
  name: 'queue:escalation:scanner',
  concurrency: 0, // publisher only at CRON layer; worker registered externally via registerEscalationScannerJob()
};

export function getEscalationScannerQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(ESCALATION_SCANNER_DEF.name, connection);
}

// Escalation deliver queue: receives jobs from escalationService; consumed by registerEscalationDeliveryWorker() (HUB-808)
const ESCALATION_DELIVER_DEF: QueueDefinition = {
  name: 'queue:escalation:deliver',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
};

export function getEscalationDeliverQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(ESCALATION_DELIVER_DEF.name, connection);
}

// Workflow hook delivery queue: event-driven; consumed by registerHookDeliveryWorker() (HUB-829)
const WORKFLOW_HOOK_DEF: QueueDefinition = {
  name: 'queue:workflow:hook',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
};

export function getWorkflowHookQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(WORKFLOW_HOOK_DEF.name, connection);
}

// Period cost aggregation queue: monthly CRON aggregates cost_ledger into billing_period_costs
const PERIOD_COST_AGGREGATOR_DEF: QueueDefinition = {
  name: 'queue:billing:period-aggregation',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (_job: Job) => {
    const { runPeriodCostAggregator } = await import('./periodCostAggregatorJob.js');
    await runPeriodCostAggregator();
  },
};

export function getPeriodCostAggregatorQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(PERIOD_COST_AGGREGATOR_DEF.name, connection);
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

// Compliance evaluation queue: daily CRON triggers runComplianceEvaluation() for all registered products
const COMPLIANCE_EVAL_DEF: QueueDefinition = {
  name: 'queue:compliance:evaluation',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (_job: Job) => {
    const { runComplianceEvaluation } = await import('../services/complianceEvaluationService.js');
    await runComplianceEvaluation();
  },
};

export function getComplianceEvalQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(COMPLIANCE_EVAL_DEF.name, connection);
}

// Human escalation queue: daily CRON fires T-7/T-1/T-0/overdue reminders for human controls (HUB-1354)
const HUMAN_ESCALATION_DEF: QueueDefinition = {
  name: 'queue:compliance:human-escalation',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (_job: Job) => {
    const { runHumanEscalationScheduler } = await import('../services/complianceAlertService.js');
    await runHumanEscalationScheduler();
  },
};

export function getHumanEscalationQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(HUMAN_ESCALATION_DEF.name, connection);
}

// Drift detection queue: daily CRON detects 7-day posture score drops (HUB-1355)
const DRIFT_DETECTION_DEF: QueueDefinition = {
  name: 'queue:compliance:drift-detection',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (_job: Job) => {
    const { runDriftDetectionEngine } = await import('../services/complianceAlertService.js');
    await runDriftDetectionEngine();
  },
};

export function getDriftDetectionQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(DRIFT_DETECTION_DEF.name, connection);
}

// Plan advisor queue: weekly CRON runs advisor for all active (product, tenant) pairs (HUB-1145)
const PLAN_ADVISOR_DEF: QueueDefinition = {
  name: 'queue:advisor:weekly',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (_job: Job) => {
    const { runWeeklyAdvisor } = await import('../services/planAdvisorService.js');
    await runWeeklyAdvisor();
  },
};

export function getPlanAdvisorQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(PLAN_ADVISOR_DEF.name, connection);
}

// Billing jobs queue: processes grandfather-subscribers and confirm-plan-change jobs (HUB-1489/1491)
const BILLING_JOBS_DEF: QueueDefinition = {
  name: 'queue:billing-jobs',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    if (job.name === 'grandfather-subscribers') {
      const { grandfatherExistingSubscribers } = await import('../services/planChangeService.js');
      const count = await grandfatherExistingSubscribers(job.data.planId as string);
      job.log?.(`grandfathered ${count} subscribers for plan ${job.data.planId as string}`);
    } else if (job.name === 'confirm-plan-change') {
      const { confirmPlanChange } = await import('../services/planChangeService.js');
      await confirmPlanChange(
        job.data.tenantId as string,
        job.data.productId as string,
        job.data.newStripePriceId as string,
      );
    }
  },
};

export function getBillingJobsQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(BILLING_JOBS_DEF.name, connection);
}

// Monthly data retention CRON job: audit_log (36-month floor) + cost_ledger (RETAIN_MONTHS)
const RETENTION_MONTHLY_DEF: QueueDefinition = {
  name: 'queue:retention:monthly',
  concurrency: 1,
  maxAttempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  deadLetterQueue: DLQ_QUEUE_NAME,
  processor: async (job: Job) => {
    if (job.name === 'retention_monthly') {
      const { runAuditLogRetention, runCostLedgerRetention } = await import('./retentionJob.js');
      await runAuditLogRetention();
      await runCostLedgerRetention();
    }
  },
};

export function getRetentionMonthlyQueue(connection?: ConnectionOptions): Queue {
  return getOrCreateQueue(RETENTION_MONTHLY_DEF.name, connection);
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
// E18 alert source queues (grace_period_expired, payment_failed, sdk_version_deprecated)
registerQueue(GRACE_PERIOD_EXPIRED_ALERTS_DEF);
registerQueue(PAYMENT_FAILED_ALERTS_DEF);
registerQueue(SDK_VERSION_DEPRECATED_ALERTS_DEF);
// E19 notifications deliver queue
registerQueue(NOTIFICATIONS_DELIVER_DEF);
// E20 escalation scanner CRON trigger + deliver queue
registerQueue(ESCALATION_SCANNER_DEF);
registerQueue(ESCALATION_DELIVER_DEF);
// E16 billing period cost aggregation CRON
registerQueue(PERIOD_COST_AGGREGATOR_DEF);
// E21 workflow hook delivery queue
registerQueue(WORKFLOW_HOOK_DEF);
// E35 compliance evaluation daily CRON
registerQueue(COMPLIANCE_EVAL_DEF);
// HUB-1354 human escalation daily CRON
registerQueue(HUMAN_ESCALATION_DEF);
// HUB-1355 drift detection daily CRON
registerQueue(DRIFT_DETECTION_DEF);
// HUB-1145 plan advisor weekly CRON
registerQueue(PLAN_ADVISOR_DEF);
// HUB-1489/1491 billing jobs (grandfather-subscribers, confirm-plan-change)
registerQueue(BILLING_JOBS_DEF);
// HUB-1524 monthly data retention (audit_log 36-month + cost_ledger RETAIN_MONTHS pruning)
registerQueue(RETENTION_MONTHLY_DEF);
// DLQ registered last; processor-less sentinel — worker skips it, ops investigate manually
registerQueue(DLQ_DEF);
