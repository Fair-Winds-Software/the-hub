// Authorized by HUB-829 — hook delivery BullMQ worker; fan-out to matching hooks; 3-retry DLQ policy
import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getRedisClient } from '../redis/client.js';
import { findMatchingHooks } from '../services/hookMatchingService.js';
import { deliverHook } from '../services/hookDeliveryService.js';
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';

interface HookJobData {
  eventType: string;
  tenantId: string;
  productId: string;
  payload: Record<string, unknown>;
  alertEventId?: string;
}

const QUEUE_NAME = 'queue:workflow:hook';

export function registerHookDeliveryWorker(): Worker {
  const connection = getRedisClient() as unknown as ConnectionOptions;

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { eventType, tenantId, productId, payload, alertEventId } = job.data as HookJobData;

      const hooks = await findMatchingHooks(eventType, tenantId, productId);
      if (hooks.length === 0) return;

      const pool = getPool();
      const failures: Error[] = [];

      // TODO: double-delivery risk on BullMQ retry — contacts re-attempted per retry cycle; accepted at v1
      for (const hook of hooks) {
        let execId: string | undefined;
        try {
          const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO workflow_hook_executions (hook_id, alert_event_id, status)
             VALUES ($1, $2, 'pending')
             RETURNING id`,
            [hook.id, alertEventId ?? null],
          );
          execId = rows[0]?.id;

          const { statusCode, durationMs } = await deliverHook(hook, payload);

          await pool.query(
            `UPDATE workflow_hook_executions SET status = 'delivered', status_code = $1, duration_ms = $2 WHERE id = $3`,
            [statusCode, durationMs, execId],
          );
          logger.info({ hookId: hook.id, eventType, statusCode, durationMs }, 'Hook delivered');
        } catch (err) {
          logger.error(
            { hookId: hook.id, eventType, error: (err as Error).message },
            'Hook delivery failed',
          );
          if (execId) {
            await pool
              .query(
                `UPDATE workflow_hook_executions SET status = 'failed', error = $1 WHERE id = $2`,
                [(err as Error).message, execId],
              )
              .catch(() => undefined);
          }
          failures.push(err as Error);
        }
      }

      if (failures.length > 0) {
        throw failures[failures.length - 1];
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const isExhausted = !job.opts.attempts || job.attemptsMade >= job.opts.attempts;
    if (!isExhausted) return;
    const data = job.data as HookJobData;
    logger.warn(
      { event: 'hook-dlq', eventType: data.eventType, jobId: job.id, error: err.message },
      'Hook delivery exhausted all retries — job moved to DLQ',
    );
  });

  return worker;
}
