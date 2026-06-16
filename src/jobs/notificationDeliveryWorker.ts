// Authorized by HUB-732 — notification delivery worker; channel fanout; 3-retry DLQ policy
import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getRedisClient } from '../redis/client.js';
import { getPool } from '../db/pool.js';
import { handleEmailDelivery } from '../services/notifications/emailHandler.js';
import { handleWebhookDelivery } from '../services/notifications/webhookHandler.js';
import { handleInAppDelivery } from '../services/notifications/inAppHandler.js';
import logger from '../lib/logger.js';
import type { AlertJobData, NotificationChannel } from '../services/notifications/types.js';

const QUEUE_NAME = 'queue:notifications:deliver';

export function registerNotificationDeliveryWorker(): Worker {
  const connection = getRedisClient() as unknown as ConnectionOptions;

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const alertData = job.data as AlertJobData;
      const { tenantId, productId, alertId } = alertData;

      const pool = getPool();
      const { rows: channels } = await pool.query<NotificationChannel>(
        `SELECT id, tenant_id, product_id, channel_type, config, hmac_secret, enabled, created_at
         FROM notification_channels
         WHERE tenant_id = $1 AND product_id = $2 AND enabled = true`,
        [tenantId, productId],
      );

      if (channels.length === 0) {
        logger.info({ alertId, tenantId, productId }, 'No active channels; skipping delivery');
        return;
      }

      const failedChannels: string[] = [];

      for (const channel of channels) {
        const { rows: [delivery] } = await pool.query<{ id: string }>(
          `INSERT INTO notification_deliveries (alert_event_id, channel_id, status)
           VALUES ($1, $2, 'pending')
           RETURNING id`,
          [alertId, channel.id],
        );
        const deliveryId = delivery!.id;

        try {
          switch (channel.channel_type) {
            case 'email':
              await handleEmailDelivery(channel, alertData);
              break;
            case 'webhook':
              await handleWebhookDelivery(channel, alertData);
              break;
            case 'in_app':
              await handleInAppDelivery(channel, alertData);
              break;
          }
          await pool.query(
            `UPDATE notification_deliveries SET status = 'delivered' WHERE id = $1`,
            [deliveryId],
          );
        } catch (err) {
          await pool.query(
            `UPDATE notification_deliveries SET status = 'failed', error = $2 WHERE id = $1`,
            [deliveryId, (err as Error).message],
          );
          failedChannels.push(channel.id);
        }
      }

      if (failedChannels.length > 0) {
        throw new Error(`Delivery failed for channels: ${failedChannels.join(', ')}`);
      }
    },
    { connection, concurrency: 1 },
  );

  // Emit warn after all retries exhausted
  worker.on('failed', (job, err) => {
    if (!job) return;
    const isExhausted = !job.opts.attempts || job.attemptsMade >= job.opts.attempts;
    if (!isExhausted) return;
    const data = job.data as AlertJobData;
    logger.warn(
      { alertId: data.alertId, tenantId: data.tenantId, productId: data.productId, error: err.message },
      'Notification delivery exhausted all retries — job moved to DLQ',
    );
  });

  return worker;
}
