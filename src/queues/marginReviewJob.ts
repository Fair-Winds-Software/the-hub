// Authorized by HUB-644 — periodic_margin_review BullMQ CRON; daily evaluation of all enabled margin configs
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';
import { evaluateMargin } from '../services/marginService.js';

export async function runPeriodicMarginReview(): Promise<void> {
  const pool = getPool();

  const { rows: pairs } = await pool.query<{ tenant_id: string; product_id: string }>(
    `SELECT DISTINCT p.tenant_id, mc.product_id
       FROM margin_configs mc
       JOIN products p ON p.id = mc.product_id
      WHERE mc.enabled = true`,
  );

  logger.info({ pairCount: pairs.length }, 'periodic_margin_review start');

  let successCount = 0;
  let failureCount = 0;

  for (const pair of pairs) {
    try {
      await evaluateMargin(pair.tenant_id, pair.product_id);
      successCount++;
    } catch (err) {
      failureCount++;
      logger.error({ err, tenantId: pair.tenant_id, productId: pair.product_id }, 'margin_review_pair_failed');
    }
  }

  logger.info({ successCount, failureCount }, 'periodic_margin_review complete');
}
