// Authorized by HUB-745 — unit tests: email delivery via nodemailer; no credentials in logs
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendMail = vi.hoisted(() => vi.fn());
const mockCreateTransport = vi.hoisted(() => vi.fn());
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

vi.mock('../../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleEmailDelivery } from '../emailHandler.js';
import type { AlertJobData, NotificationChannel } from '../types.js';

const CHANNEL: NotificationChannel = {
  id: 'ch-111',
  tenant_id: 'ten-111',
  product_id: 'prod-111',
  channel_type: 'email',
  config: { to: 'ops@example.com' },
  hmac_secret: null,
  enabled: true,
  created_at: new Date(),
};

const ALERT: AlertJobData = {
  alertId: 'alert-111',
  tenantId: 'ten-111',
  productId: 'prod-111',
  alertType: 'below_floor',
  severity: 'warning',
  fireCount: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });
  mockSendMail.mockResolvedValue({ messageId: 'msg-1' });
});

describe('handleEmailDelivery', () => {
  it('throws AppError 500 when EMAIL_HOST env is missing', async () => {
    delete process.env.EMAIL_HOST;
    await expect(handleEmailDelivery(CHANNEL, ALERT)).rejects.toMatchObject({ statusCode: 500 });
  });

  it('calls sendMail with correct to and subject fields', async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    await handleEmailDelivery(CHANNEL, ALERT);
    expect(mockSendMail).toHaveBeenCalledOnce();
    const [args] = mockSendMail.mock.calls[0]!;
    expect(args.to).toBe('ops@example.com');
    expect(args.subject).toContain('below_floor');
    expect(args.subject).toContain('warning');
  });

  it('uses custom subjectTemplate when provided in config', async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    const channel = { ...CHANNEL, config: { to: 'ops@example.com', subjectTemplate: 'ALERT: {alertType}' } };
    await handleEmailDelivery(channel, ALERT);
    const [args] = mockSendMail.mock.calls[0]!;
    expect(args.subject).toBe('ALERT: below_floor');
  });

  it('uses EMAIL_FROM env as from when config.from is not set', async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    process.env.EMAIL_FROM = 'noreply@hub.io';
    await handleEmailDelivery(CHANNEL, ALERT);
    const [args] = mockSendMail.mock.calls[0]!;
    expect(args.from).toBe('noreply@hub.io');
    delete process.env.EMAIL_FROM;
  });

  it('uses config.from when present, overriding EMAIL_FROM', async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    process.env.EMAIL_FROM = 'noreply@hub.io';
    const channel = { ...CHANNEL, config: { to: 'ops@example.com', from: 'custom@hub.io' } };
    await handleEmailDelivery(channel, ALERT);
    const [args] = mockSendMail.mock.calls[0]!;
    expect(args.from).toBe('custom@hub.io');
    delete process.env.EMAIL_FROM;
  });

  it('includes alertId and tenantId in email body text', async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    await handleEmailDelivery(CHANNEL, ALERT);
    const [args] = mockSendMail.mock.calls[0]!;
    expect(args.text).toContain(ALERT.alertId);
    expect(args.text).toContain(ALERT.tenantId);
  });

  it('rethrows sendMail error', async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    mockSendMail.mockRejectedValue(new Error('SMTP connect error'));
    await expect(handleEmailDelivery(CHANNEL, ALERT)).rejects.toThrow('SMTP connect error');
  });

  it('does not include auth credentials in createTransport when EMAIL_USER is not set', async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    delete process.env.EMAIL_USER;
    await handleEmailDelivery(CHANNEL, ALERT);
    const [transportConfig] = mockCreateTransport.mock.calls[0]!;
    expect(transportConfig.auth).toBeUndefined();
  });
});
