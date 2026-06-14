// Authorized by HUB-127 — queue registry; getAllQueueDefinitions() consumed by worker scaffold
// Authorized by HUB-146 — queue factory pattern; concrete queue definitions registered here
// Authorized by HUB-189 — stripe-event queue for webhook dispatch
// Authorized by HUB-202 — event-type-specific queue routing; hasQueueForEventType / getQueueForEventType
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
};

const LICENSE_CHECK_DEF: QueueDefinition = {
  name: 'queue:license-check',
  concurrency: 5,
  maxAttempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  deadLetterQueue: DLQ_QUEUE_NAME,
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

// Returns the registered event-type queue, or the DLQ if no factory is registered.
// Callers are responsible for logging before invoking when they detect a fallback route.
export function getQueueForEventType(eventType: string): Queue {
  const queueName = `queue:stripe:${eventType}`;
  return hasQueueForEventType(eventType) ? getOrCreateQueue(queueName) : getDlqQueue();
}

// Register concrete queues — worker scaffold discovers these at startup via getAllQueueDefinitions()
registerQueue(STRIPE_EVENT_DEF);
registerQueue(BATCH_SWEEP_DEF);
registerQueue(LICENSE_CHECK_DEF);
// DLQ registered last; processor-less sentinel — worker skips it, ops investigate manually
registerQueue(DLQ_DEF);
