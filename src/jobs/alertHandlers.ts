// Authorized by HUB-719 — four BullMQ workers consuming alert source queues; delegate to ingestAlert()
import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getRedisClientForBullMQ } from '../redis/client.js';
import { ingestAlert } from '../services/alertService.js';
import logger from '../lib/logger.js';

// HUB-1712: colon-free names + BullMQ-compatible client + explicit prefix
export function registerAlertHandlers(): Worker[] {
  const connection = getRedisClientForBullMQ() as unknown as ConnectionOptions;
  const workers: Worker[] = [];

  workers.push(
    new Worker(
      'alerts.below_floor',
      async (job) => {
        const { tenantId, productId, dedupKey, marginPercentage, floorPercentage } = job.data as {
          tenantId: string; productId: string; dedupKey?: string;
          marginPercentage: number; floorPercentage: number;
        };
        try {
          const result = await ingestAlert({
            tenantId, productId,
            alertType: 'below_floor',
            payload: { marginPercentage, floorPercentage },
            dedupKey,
          });
          logger.info({ tenantId, productId, alert_type: 'below_floor', ...result }, 'alert ingested');
        } catch (err) {
          logger.error({ err, tenantId, productId, alert_type: 'below_floor' }, 'alert ingest failed');
          throw err;
        }
      },
      { connection, concurrency: 1, prefix: 'hub:queue' },
    ),
  );

  workers.push(
    new Worker(
      'alerts.grace_period_expired',
      async (job) => {
        const { tenantId, productId, dedupKey, leaseId, expiredAt } = job.data as {
          tenantId: string; productId: string; dedupKey?: string;
          leaseId: string; expiredAt: string;
        };
        try {
          const result = await ingestAlert({
            tenantId, productId,
            alertType: 'grace_period_expired',
            payload: { leaseId, expiredAt },
            dedupKey,
          });
          logger.info({ tenantId, productId, alert_type: 'grace_period_expired', ...result }, 'alert ingested');
        } catch (err) {
          logger.error({ err, tenantId, productId, alert_type: 'grace_period_expired' }, 'alert ingest failed');
          throw err;
        }
      },
      { connection, concurrency: 1, prefix: 'hub:queue' },
    ),
  );

  workers.push(
    new Worker(
      'alerts.payment_failed',
      async (job) => {
        const { tenantId, productId, dedupKey, stripeInvoiceId, failureReason } = job.data as {
          tenantId: string; productId: string; dedupKey?: string;
          stripeInvoiceId: string; failureReason: string;
        };
        try {
          const result = await ingestAlert({
            tenantId, productId,
            alertType: 'payment_failed',
            payload: { stripeInvoiceId, failureReason },
            dedupKey,
          });
          logger.info({ tenantId, productId, alert_type: 'payment_failed', ...result }, 'alert ingested');
        } catch (err) {
          logger.error({ err, tenantId, productId, alert_type: 'payment_failed' }, 'alert ingest failed');
          throw err;
        }
      },
      { connection, concurrency: 1, prefix: 'hub:queue' },
    ),
  );

  workers.push(
    new Worker(
      'alerts.sdk_version_deprecated',
      async (job) => {
        const { tenantId, productId, dedupKey, sdkVersion, deprecatedAt } = job.data as {
          tenantId: string; productId: string; dedupKey?: string;
          sdkVersion: string; deprecatedAt: string;
        };
        try {
          const result = await ingestAlert({
            tenantId, productId,
            alertType: 'sdk_version_deprecated',
            payload: { sdkVersion, deprecatedAt },
            dedupKey,
          });
          logger.info({ tenantId, productId, alert_type: 'sdk_version_deprecated', ...result }, 'alert ingested');
        } catch (err) {
          logger.error({ err, tenantId, productId, alert_type: 'sdk_version_deprecated' }, 'alert ingest failed');
          throw err;
        }
      },
      { connection, concurrency: 1, prefix: 'hub:queue' },
    ),
  );

  return workers;
}
