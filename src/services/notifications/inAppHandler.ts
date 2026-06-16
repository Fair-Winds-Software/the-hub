// Authorized by HUB-747 — in-app notification handler; INSERT into in_app_notifications; returns inserted id
import { getPool } from '../../db/pool.js';
import logger from '../../lib/logger.js';
import type { AlertJobData, NotificationChannel } from './types.js';

// TODO: future v2 — support channel.config.read_timeout_hours for auto-dismiss

export async function handleInAppDelivery(_channel: NotificationChannel, alertData: AlertJobData): Promise<string> {
  const message = `[${alertData.severity.toUpperCase()}] ${alertData.alertType} fired for product ${alertData.productId} (fire #${alertData.fireCount})`;

  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO in_app_notifications (tenant_id, product_id, alert_event_id, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [alertData.tenantId, alertData.productId, alertData.alertId, message],
  );

  const notificationId = rows[0]!.id;
  logger.info({ alertId: alertData.alertId, channelId: _channel.id, notificationId, tenantId: alertData.tenantId }, 'In-app notification created');
  return notificationId;
}
