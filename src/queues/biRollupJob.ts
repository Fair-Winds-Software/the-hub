// Authorized by HUB-1806 (S4 of HUB-1785) — BullMQ processor entry for the bi-rollup
// queue. One job name per window: 'bi_rollup_hourly', 'bi_rollup_daily',
// 'bi_rollup_monthly'. Job payload is unused today — the window is inferred from
// the job name. This module stays thin; all the aggregation logic lives in
// rollupService.ts so tests can exercise the SQL path without a queue harness.
import type { Job } from 'bullmq';
import logger from '../lib/logger.js';
import { runRollup, type RollupWindow } from '../services/bi/rollupService.js';

const JOB_TO_WINDOW: Record<string, RollupWindow> = {
  bi_rollup_hourly: 'hourly',
  bi_rollup_daily: 'daily',
  bi_rollup_monthly: 'monthly',
};

export async function runBiRollupJob(job: Job): Promise<void> {
  const window = JOB_TO_WINDOW[job.name];
  if (!window) {
    logger.warn({ jobName: job.name }, 'bi_rollup_unknown_job_name');
    return;
  }
  const result = await runRollup({ window });
  logger.info({ jobName: job.name, ...result }, 'bi_rollup_job_complete');
}
