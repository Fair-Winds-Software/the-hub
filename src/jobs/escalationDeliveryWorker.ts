// Authorized by HUB-808 — escalation delivery worker; email/webhook/sms contact fan-out; 3-retry DLQ policy
import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import nodemailer from 'nodemailer';
import { getRedisClient } from '../redis/client.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

interface EscalationJobData {
  alertEventId: string;
  tier: number;
  contacts: Array<{ type: string; value: string }>;
  alertType: string;
  tenantId: string;
  productId: string;
}

const QUEUE_NAME = 'queue:escalation:deliver';

export function registerEscalationDeliveryWorker(): Worker {
  const connection = getRedisClient() as unknown as ConnectionOptions;

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { alertEventId, tier, contacts, alertType, tenantId, productId } = job.data as EscalationJobData;
      const failures: Error[] = [];

      // TODO: double-delivery risk on BullMQ retry — accepted trade-off at v1; contacts re-attempted per retry cycle
      for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i]!;
        try {
          switch (contact.type) {
            case 'email':
              await sendEscalationEmail(contact.value, alertType, tier, alertEventId);
              break;
            case 'webhook':
              await sendEscalationWebhook(contact.value, { alertEventId, tier, alertType, tenantId, productId });
              break;
            case 'sms':
              logger.warn({ contactType: 'sms', contactIndex: i, alertEventId, tier }, 'SMS escalation not implemented at v1');
              break;
            default:
              logger.warn({ contactType: contact.type, contactIndex: i, alertEventId, tier }, `Unknown escalation contact type: ${contact.type}`);
          }
        } catch (err) {
          logger.error({ contactType: contact.type, contactIndex: i, alertEventId, tier, error: (err as Error).message }, 'Escalation contact delivery failed');
          failures.push(err as Error);
        }
      }

      if (failures.length > 0) {
        throw failures[failures.length - 1];
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const isExhausted = !job.opts.attempts || job.attemptsMade >= job.opts.attempts;
    if (!isExhausted) return;
    const data = job.data as EscalationJobData;
    logger.error(
      { event: 'escalation-dlq', alertEventId: data.alertEventId, tier: data.tier, jobId: job.id, error: err.message },
      'Escalation delivery exhausted all retries — job moved to DLQ',
    );
  });

  return worker;
}

async function sendEscalationEmail(to: string, alertType: string, tier: number, alertEventId: string): Promise<void> {
  const host = process.env.EMAIL_HOST;
  if (!host) throw new AppError(500, 'Email handler not configured');

  const from = process.env.EMAIL_FROM ?? 'escalation@hub.internal';
  const subject = `[HUB Escalation] ${alertType} — Tier ${tier}`;
  const text = `Alert Event ID: ${alertEventId}\nAlert Type: ${alertType}\nEscalation Tier: ${tier}`;

  const transport = nodemailer.createTransport({
    host,
    port: parseInt(process.env.EMAIL_PORT ?? '587', 10),
    auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } : undefined,
  });

  await transport.sendMail({ from, to, subject, text });
}

async function sendEscalationWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  // TODO: add HMAC signing when hmac_secret is added to escalation_contacts schema (distinct from E19 notification_channels)
  const body = JSON.stringify({ event: 'escalation', ...payload, timestamp: new Date().toISOString() });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new AppError(502, `Escalation webhook delivery failed: ${res.status}`);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new AppError(504, 'Escalation webhook delivery timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
