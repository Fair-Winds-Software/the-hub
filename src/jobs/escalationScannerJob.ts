// Authorized by HUB-787 — escalation scanner CRON worker; 5-min tick; 30s overrun warn; re-throws on error
import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getRedisClientForBullMQ } from '../redis/client.js';
import { runEscalationScan } from '../services/escalationService.js';
import logger from '../lib/logger.js';

// HUB-1712: colon-free name + BullMQ-compatible client + explicit prefix
const QUEUE_NAME = 'escalation.scanner';
const OVERRUN_WARN_MS = 30_000;

export function registerEscalationScannerJob(): Worker {
  const connection = getRedisClientForBullMQ() as unknown as ConnectionOptions;

  const worker = new Worker(
    QUEUE_NAME,
    async (_job) => {
      const tickAt = new Date().toISOString();
      const startTime = Date.now();
      try {
        const { scanned, escalated } = await runEscalationScan();
        const elapsed_ms = Date.now() - startTime;
        if (elapsed_ms > OVERRUN_WARN_MS) {
          logger.warn({ tickAt, elapsed_ms }, 'Escalation scanner tick overrun (>30s)');
        }
        logger.info({ tickAt, escalationsFound: escalated, scanned, elapsed_ms }, 'Escalation scanner tick complete');
      } catch (err) {
        const elapsed_ms = Date.now() - startTime;
        logger.error({ error: (err as Error).message, elapsed_ms }, 'Escalation scanner tick failed');
        throw err;
      }
    },
    { connection, concurrency: 1, prefix: 'hub:queue' },
  );

  return worker;
}
