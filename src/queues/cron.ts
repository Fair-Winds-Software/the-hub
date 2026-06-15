// Authorized by HUB-161 — CRON job registry; idempotent BullMQ repeatable job registration
// Authorized by HUB-272 — promote_staged_license_changes CRON entry; D-002 billing cycle boundary
// Authorized by HUB-336 — sdk-version-retention-cron CRON entry; D-003 retention interval
// Authorized by HUB-517 — grace-period-expiry-scanner CRON entry; D-004 expiry scan interval
import type { Queue } from 'bullmq';
import { getBatchSweepQueue, getLicenseCheckQueue, getGracePeriodExpiryScannerQueue } from './index.js';
import { D_002_PROMOTION_CRON, D_003_RETENTION_CRON, D_004_GRACE_PERIOD_SCANNER_CRON } from '../config/decisions.js';
import logger from '../lib/logger.js';

interface CronDefinition {
  queueFactory: () => Queue;
  name: string;
  cron: string;
  payload: Record<string, unknown>;
}

// Authoritative list of all scheduled work in the HUB.
// Adding a new scheduled job = one entry here + one queue factory in src/queues/index.ts.
const CRON_DEFINITIONS: CronDefinition[] = [
  {
    queueFactory: getBatchSweepQueue,
    name: 'batch-sweep-daily',
    cron: '0 0 * * *',
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getLicenseCheckQueue,
    name: 'license-check-hourly',
    cron: '0 * * * *',
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getLicenseCheckQueue,
    name: 'promote_staged_license_changes',
    cron: D_002_PROMOTION_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getBatchSweepQueue,
    name: 'sdk-version-retention-cron',
    cron: D_003_RETENTION_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getGracePeriodExpiryScannerQueue,
    name: 'grace-period-expiry-scanner',
    cron: D_004_GRACE_PERIOD_SCANNER_CRON,
    payload: { triggered: 'scheduled' },
  },
];

export async function registerAllCronJobs(): Promise<void> {
  if (process.env.CRON_ENABLED === 'false') {
    logger.info('CRON_ENABLED=false — skipping CRON registration');
    return;
  }

  let registered = 0;

  for (const def of CRON_DEFINITIONS) {
    try {
      const queue = def.queueFactory();

      // Remove existing repeatable before re-adding — prevents duplication on worker restart
      await queue.removeRepeatable(def.name, { pattern: def.cron });

      await queue.add(def.name, def.payload, {
        repeat: { pattern: def.cron },
      });

      logger.info({ job: def.name, cron: def.cron, queue: queue.name }, 'CRON job registered');
      registered++;
    } catch (err) {
      logger.error({ job: def.name, err }, 'CRON registration failed — continuing with remaining');
    }
  }

  logger.info({ registered, total: CRON_DEFINITIONS.length }, 'CRON registration complete');
}
