// Authorized by HUB-127 — BullMQ worker process; separate from Fastify, graceful SIGTERM drain
import 'dotenv/config';
import { Worker as BullWorker, type Job } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { fileURLToPath } from 'url';
import { getRedisClient } from './redis/client.js';
import { getAllQueueDefinitions } from './queues/index.js';
import logger from './lib/logger.js';

const DRAIN_TIMEOUT_MS = 30_000;

// Stub processor used when a queue definition provides no custom processor.
// Downstream Epics replace this per-queue with business-specific processors.
const stubProcessor = async (job: Job): Promise<void> => {
  logger.info({ jobId: job.id, queue: job.queueName }, 'Job received');
};

export function createWorkers(): BullWorker[] {
  // Cast required: BullMQ bundles its own ioredis version, causing structural
  // type incompatibility at compile time despite runtime compatibility.
  const connection = getRedisClient() as unknown as ConnectionOptions;
  const definitions = getAllQueueDefinitions();

  return definitions.map((def) => {
    // WORKER_CONCURRENCY_<QUEUE_NAME_UPPER_SNAKE> overrides the default
    const envKey = `WORKER_CONCURRENCY_${def.name.replace(/-/g, '_').toUpperCase()}`;
    const concurrency = parseInt(process.env[envKey] ?? String(def.concurrency), 10);

    logger.info({ queue: def.name, concurrency }, 'Worker watching queue');
    return new BullWorker(def.name, def.processor ?? stubProcessor, { connection, concurrency });
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

  process.on('SIGTERM', () => {
    gracefulShutdown(workers).catch(() => process.exit(1));
  });
}
