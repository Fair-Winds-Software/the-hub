// Authorized by HUB-672 — period_cost_aggregator BullMQ CRON; monthly billing period cost aggregation for all active products
// TODO-D-DEF-003: if pre-aggregated granularity decided, this CRON becomes a no-op; billing_period_costs supports direct writes
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';
import { aggregatePeriodCosts } from '../services/billingPeriodCostService.js';

export async function runPeriodCostAggregator(): Promise<void> {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const pool = getPool();
  const { rows: pairs } = await pool.query<{ tenant_id: string; product_id: string }>(
    `SELECT tenant_id, id AS product_id
       FROM products
      WHERE status = 'active'`,
  );

  logger.info({ pairCount: pairs.length, period_start: periodStart, period_end: periodEnd }, 'period_cost_aggregator start');

  let successCount = 0;
  let failureCount = 0;

  for (const pair of pairs) {
    try {
      await aggregatePeriodCosts(pair.tenant_id, pair.product_id, periodStart, periodEnd);
      successCount++;
    } catch (err) {
      failureCount++;
      logger.error({ err, tenantId: pair.tenant_id, productId: pair.product_id }, 'period_cost_aggregator_pair_failed');
    }
  }

  logger.info({ successCount, failureCount }, 'period_cost_aggregator complete');
}
