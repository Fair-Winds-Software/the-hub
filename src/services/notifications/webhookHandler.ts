// Authorized by HUB-746 — webhook channel handler; HMAC-SHA256 signing; hmac_secret never logged
import { createHmac } from 'crypto';
import { AppError } from '../../errors/AppError.js';
import logger from '../../lib/logger.js';
import type { AlertJobData, NotificationChannel } from './types.js';

export async function handleWebhookDelivery(channel: NotificationChannel, alertData: AlertJobData): Promise<void> {
  if (!channel.hmac_secret) throw new AppError(400, 'Webhook channel missing hmac_secret');

  const config = channel.config as { url: string };
  const payload = {
    event: alertData.alertType,
    severity: alertData.severity,
    tenantId: alertData.tenantId,
    productId: alertData.productId,
    alertId: alertData.alertId,
    fireCount: alertData.fireCount,
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', channel.hmac_secret).update(body).digest('hex');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new AppError(502, `Webhook delivery failed: ${res.status}`);
    }

    logger.info({ alertId: alertData.alertId, channelId: channel.id, url: config.url, statusCode: res.status }, 'Webhook delivered');
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      const timedOut = new AppError(504, 'Webhook delivery timed out');
      logger.error({ alertId: alertData.alertId, channelId: channel.id, url: config.url, error: timedOut.message }, 'Webhook timed out');
      throw timedOut;
    }
    logger.error({ alertId: alertData.alertId, channelId: channel.id, url: config.url, error: (err as Error).message }, 'Webhook delivery failed');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
