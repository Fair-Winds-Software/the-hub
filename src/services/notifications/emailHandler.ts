// Authorized by HUB-745 — email channel handler; nodemailer SMTP; no credentials in logs
import nodemailer from 'nodemailer';
import { AppError } from '../../errors/AppError.js';
import logger from '../../lib/logger.js';
import type { AlertJobData, NotificationChannel } from './types.js';

export async function handleEmailDelivery(channel: NotificationChannel, alertData: AlertJobData): Promise<void> {
  const host = process.env.EMAIL_HOST;
  if (!host) throw new AppError(500, 'Email handler not configured');

  const config = channel.config as { to: string; from?: string; subjectTemplate?: string };
  const from = config.from ?? (process.env.EMAIL_FROM ?? 'alerts@hub.internal');
  const subjectTemplate = config.subjectTemplate ?? '[HUB Alert] {alertType} - {severity}';
  const subject = subjectTemplate
    .replace('{alertType}', alertData.alertType)
    .replace('{severity}', alertData.severity);

  const body = [
    `Alert ID:   ${alertData.alertId}`,
    `Tenant ID:  ${alertData.tenantId}`,
    `Product ID: ${alertData.productId}`,
    `Alert Type: ${alertData.alertType}`,
    `Severity:   ${alertData.severity}`,
    `Fire Count: ${alertData.fireCount}`,
  ].join('\n');

  const transport = nodemailer.createTransport({
    host,
    port: parseInt(process.env.EMAIL_PORT ?? '587', 10),
    auth: process.env.EMAIL_USER
      ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      : undefined,
  });

  try {
    await transport.sendMail({ from, to: config.to, subject, text: body });
    logger.info({ alertId: alertData.alertId, channelId: channel.id, to: config.to }, 'Email delivered');
  } catch (err) {
    logger.error({ alertId: alertData.alertId, channelId: channel.id, error: (err as Error).message }, 'Email delivery failed');
    throw err;
  }
}
