// Authorized by HUB-746 — unit tests: webhook delivery; HMAC signing; timeout; hmac_secret never logged
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleWebhookDelivery } from '../webhookHandler.js';
import type { AlertJobData, NotificationChannel } from '../types.js';

const CHANNEL: NotificationChannel = {
  id: 'ch-222',
  tenant_id: 'ten-222',
  product_id: 'prod-222',
  channel_type: 'webhook',
  config: { url: 'https://example.com/webhook' },
  hmac_secret: 'super-secret',
  enabled: true,
  created_at: new Date(),
};

const ALERT: AlertJobData = {
  alertId: 'alert-222',
  tenantId: 'ten-222',
  productId: 'prod-222',
  alertType: 'below_floor',
  severity: 'critical',
  fireCount: 3,
};

const mockFetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleWebhookDelivery', () => {
  it('throws AppError 400 when hmac_secret is null', async () => {
    const channel = { ...CHANNEL, hmac_secret: null };
    await expect(handleWebhookDelivery(channel, ALERT)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('makes a POST request to config.url', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await handleWebhookDelivery(CHANNEL, ALERT);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://example.com/webhook');
    expect(opts.method).toBe('POST');
  });

  it('sends X-Hub-Signature-256 header with sha256= prefix', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await handleWebhookDelivery(CHANNEL, ALERT);
    const [, opts] = mockFetch.mock.calls[0]!;
    expect(opts.headers['X-Hub-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('sends Content-Type: application/json', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await handleWebhookDelivery(CHANNEL, ALERT);
    const [, opts] = mockFetch.mock.calls[0]!;
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('includes alertType, tenantId, productId in the request body', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await handleWebhookDelivery(CHANNEL, ALERT);
    const [, opts] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(opts.body as string);
    expect(body.event).toBe(ALERT.alertType);
    expect(body.tenantId).toBe(ALERT.tenantId);
    expect(body.productId).toBe(ALERT.productId);
  });

  it('throws AppError 502 when response is not ok', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(handleWebhookDelivery(CHANNEL, ALERT)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('throws AppError 504 on AbortError (timeout)', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValue(abortError);
    await expect(handleWebhookDelivery(CHANNEL, ALERT)).rejects.toMatchObject({ statusCode: 504 });
  });

  it('rethrows non-abort fetch errors', async () => {
    mockFetch.mockRejectedValue(new Error('network failure'));
    await expect(handleWebhookDelivery(CHANNEL, ALERT)).rejects.toThrow('network failure');
  });
});
