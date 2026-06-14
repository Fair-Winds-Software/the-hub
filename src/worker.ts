// Authorized by HUB-127 — BullMQ worker process; separate from Fastify, graceful SIGTERM drain
// Authorized by HUB-147 — DLQ listener; failed-job capture with PII-safe structured logging
import 'dotenv/config';
import { Worker as BullWorker, type Job } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { fileURLToPath } from 'url';
import { getRedisClient } from './redis/client.js';
import { getAllQueueDefinitions, getDlqQueue } from './queues/index.js';
import { registerAllCronJobs } from './queues/cron.js';
import { sanitizePayload } from './utils/sanitize.js';
import logger from './lib/logger.js';

const DRAIN_TIMEOUT_MS = 30_000;

export function createWorkers(): BullWorker[] {
  // Cast required: BullMQ bundles its own ioredis version, causing structural
  // type incompatibility at compile time despite runtime compatibility.
  const connection = getRedisClient() as unknown as ConnectionOptions;
  const definitions = getAllQueueDefinitions();

  // Skip processor-less entries (e.g. DLQ sentinel) — they have no active worker
  return definitions
    .filter((def) => def.processor !== undefined)
    .map((def) => {
      // WORKER_CONCURRENCY_<QUEUE_NAME_UPPER_SNAKE> overrides the default
      const envKey = `WORKER_CONCURRENCY_${def.name.replace(/-/g, '_').toUpperCase()}`;
      const concurrency = parseInt(process.env[envKey] ?? String(def.concurrency), 10);

      logger.info({ queue: def.name, concurrency }, 'Worker watching queue');
      const worker = new BullWorker(def.name, def.processor!, { connection, concurrency });

      // Move permanently failed jobs to DLQ with PII-safe structured logging
      if (def.deadLetterQueue) {
        worker.on('failed', async (job: Job | undefined, err: Error) => {
          if (!job) return;
          // Only act on final failure (all attempts exhausted)
          const isExhausted = !job.opts.attempts || job.attemptsMade >= job.opts.attempts;
          if (!isExhausted) return;

          const sanitized = sanitizePayload(job.data);
          const payloadSummary = JSON.stringify(sanitized).slice(0, 200);

          logger.error(
            { jobId: job.id, queue: def.name, payloadSummary, failureReason: err.message, attemptsMade: job.attemptsMade },
            'Job permanently failed — moving to DLQ',
          );

          try {
            const dlq = getDlqQueue(connection);
            await dlq.add('dead-letter', {
              originalQueue: def.name,
              originalJobId: job.id,
              failedReason: err.message,
              payload: sanitized,
            });
          } catch (dlqErr) {
            logger.error({ err: dlqErr }, 'Failed to enqueue job to DLQ');
          }
        });
      }

      return worker;
    });
}

export async function gracefulShutdown(workers: BullWorker[]): Promise<void> {
  logger.info({ workerCount: workers.length }, 'SIGTERM received — draining workers');

  const drain = Promise.allSettled(workers.map((w) => w.close()));
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('drain timeout')), DRAIN_TIMEOUT_MS)
  );

  try {
    await Promise.race([drain, timeout]);
    logger.info('All workers drained — exiting');
    process.exit(0);
  } catch {
    logger.error({ timeoutMs: DRAIN_TIMEOUT_MS }, 'Worker drain timed out — forcing exit');
    process.exit(1);
  }
}

// Entry point: only executes when this file is run directly (npm run worker)
const __filename = fileURLToPath(import.meta.url);
const isEntryPoint =
  process.argv[1] === __filename ||
  process.argv[1]?.endsWith('worker.ts') ||
  process.argv[1]?.endsWith('worker.js');

if (isEntryPoint) {
  let workers: BullWorker[] = [];
  try {
    workers = createWorkers();
    if (workers.length === 0) {
      logger.warn('No queues registered — worker process is idle. Register queues in src/queues/index.ts.');
    }
  } catch (err) {
    logger.error({ err }, 'Worker startup failed — Redis unreachable or queue configuration error');
    process.exit(1);
  }

  // Register CRON jobs after workers are running
  registerAllCronJobs().catch((err) => {
    logger.error({ err }, 'CRON registration error — worker continuing');
  });

  process.on('SIGTERM', () => {
    gracefulShutdown(workers).catch(() => process.exit(1));
  });
}
