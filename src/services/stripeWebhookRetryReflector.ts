// Authorized by HUB-1545 (System Health spec-deviation close-out) —
// mirror BullMQ retry lifecycle onto stripe_webhook_events.status so
// /admin/system-health/stripe-webhooks can surface pending_retry as a
// first-class value (previously always 0 because no code path wrote it).
//
// Wired from worker.ts's shared worker.on('failed') listener for any
// queue whose name starts with `queue:stripe` — the stripe event queue
// or the event-type-specific queues (queue:stripe:invoice.created, etc.).

import type { Job } from 'bullmq';
import { getPool } from '../db/pool.js';

interface StripeJobData {
  event_id?: string;
}

export async function reflectStripeWebhookRetry(
  job: Job,
  isExhausted: boolean,
): Promise<void> {
  const data = job.data as StripeJobData;
  const eventId = data.event_id;
  if (!eventId) return;

  if (isExhausted) {
    await getPool().query(
      `UPDATE stripe_webhook_events
          SET status = 'failed', next_retry_at = NULL
        WHERE event_id = $1`,
      [eventId],
    );
    return;
  }

  const nextRetryDelayMs = getNextRetryDelayMs(job);
  const nextRetryAt = nextRetryDelayMs !== null
    ? new Date(Date.now() + nextRetryDelayMs)
    : null;

  await getPool().query(
    `UPDATE stripe_webhook_events
        SET status = 'pending_retry', next_retry_at = $2
      WHERE event_id = $1`,
    [eventId, nextRetryAt],
  );
}

function getNextRetryDelayMs(job: Job): number | null {
  const backoff = job.opts.backoff;
  if (!backoff || typeof backoff === 'number') {
    return typeof backoff === 'number' ? backoff : null;
  }
  if (backoff.type === 'fixed') return backoff.delay ?? null;
  if (backoff.type === 'exponential') {
    const base = backoff.delay ?? 500;
    return base * 2 ** job.attemptsMade;
  }
  return null;
}
