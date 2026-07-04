// Authorized by HUB-732 — unit tests: notification delivery worker; channel fanout; DLQ warn after retries
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockWorkerOn = vi.hoisted(() => vi.fn());
const mockWorkerConstructor = vi.hoisted(() => vi.fn());
vi.mock('bullmq', () => ({
  Worker: mockWorkerConstructor,
}));

vi.mock('../../redis/client.js', () => ({
  getRedisClientForBullMQ: vi.fn().mockReturnValue({}),
}));

const mockPoolQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

vi.mock('../../services/notifications/emailHandler.js', () => ({
  handleEmailDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/notifications/webhookHandler.js', () => ({
  handleWebhookDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/notifications/inAppHandler.js', () => ({
  handleInAppDelivery: vi.fn().mockResolvedValue('notif-id'),
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerNotificationDeliveryWorker } from '../notificationDeliveryWorker.js';
import { handleEmailDelivery } from '../../services/notifications/emailHandler.js';
import { handleWebhookDelivery } from '../../services/notifications/webhookHandler.js';
import { handleInAppDelivery } from '../../services/notifications/inAppHandler.js';

const TENANT_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ALERT_ID   = 'cccccccc-0000-0000-0000-000000000003';

const JOB_DATA = { alertId: ALERT_ID, tenantId: TENANT_ID, productId: PRODUCT_ID, alertType: 'below_floor', severity: 'warning', fireCount: 1 };

function captureWorkerHandler(): (job: { data: typeof JOB_DATA }) => Promise<void> {
  return mockWorkerConstructor.mock.calls[0]?.[1] as (job: { data: typeof JOB_DATA }) => Promise<void>;
}

const EMAIL_CHANNEL    = { id: 'ch-1', channel_type: 'email',   config: { to: 'ops@x.com' }, hmac_secret: null,        enabled: true };
const WEBHOOK_CHANNEL  = { id: 'ch-2', channel_type: 'webhook', config: { url: 'https://x' }, hmac_secret: 'secret',   enabled: true };
const IN_APP_CHANNEL   = { id: 'ch-3', channel_type: 'in_app',  config: {},                   hmac_secret: null,        enabled: true };

beforeEach(() => {
  vi.resetAllMocks();
  mockWorkerConstructor.mockImplementation((_name: string, _handler: unknown, _opts: unknown) => ({
    on: mockWorkerOn,
  }));
});

describe('registerNotificationDeliveryWorker', () => {
  it('returns a Worker instance', () => {
    const worker = registerNotificationDeliveryWorker();
    expect(worker).toBeDefined();
    expect(mockWorkerConstructor).toHaveBeenCalledOnce();
  });

  it('registers on(failed) listener for DLQ warn', () => {
    registerNotificationDeliveryWorker();
    expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('logs info and returns early when no active channels exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    registerNotificationDeliveryWorker();
    const handler = captureWorkerHandler();
    await handler({ data: JOB_DATA });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('dispatches email channel to handleEmailDelivery', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [EMAIL_CHANNEL] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    registerNotificationDeliveryWorker();
    const handler = captureWorkerHandler();
    await handler({ data: JOB_DATA });
    expect(handleEmailDelivery).toHaveBeenCalledOnce();
  });

  it('dispatches webhook channel to handleWebhookDelivery', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [WEBHOOK_CHANNEL] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-2' }] })
      .mockResolvedValueOnce({ rows: [] });
    registerNotificationDeliveryWorker();
    const handler = captureWorkerHandler();
    await handler({ data: JOB_DATA });
    expect(handleWebhookDelivery).toHaveBeenCalledOnce();
  });

  it('dispatches in_app channel to handleInAppDelivery', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [IN_APP_CHANNEL] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-3' }] })
      .mockResolvedValueOnce({ rows: [] });
    registerNotificationDeliveryWorker();
    const handler = captureWorkerHandler();
    await handler({ data: JOB_DATA });
    expect(handleInAppDelivery).toHaveBeenCalledOnce();
  });

  it('marks delivery delivered on success', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [EMAIL_CHANNEL] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-4' }] })
      .mockResolvedValueOnce({ rows: [] });
    registerNotificationDeliveryWorker();
    const handler = captureWorkerHandler();
    await handler({ data: JOB_DATA });
    const updateCall = mockPoolQuery.mock.calls[2]!;
    expect(updateCall[0]).toContain("status = 'delivered'");
  });

  it('marks delivery failed and throws when handler rejects', async () => {
    vi.mocked(handleEmailDelivery).mockRejectedValueOnce(new Error('SMTP down'));
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [EMAIL_CHANNEL] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-5' }] })
      .mockResolvedValueOnce({ rows: [] });
    registerNotificationDeliveryWorker();
    const handler = captureWorkerHandler();
    await expect(handler({ data: JOB_DATA })).rejects.toThrow('Delivery failed for channels');
    const updateCall = mockPoolQuery.mock.calls[2]!;
    expect(updateCall[0]).toContain("status = 'failed'");
  });

  it('processes all channels even when earlier ones fail', async () => {
    vi.mocked(handleEmailDelivery).mockRejectedValueOnce(new Error('fail'));
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [EMAIL_CHANNEL, IN_APP_CHANNEL] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-6' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-7' }] })
      .mockResolvedValueOnce({ rows: [] });
    registerNotificationDeliveryWorker();
    const handler = captureWorkerHandler();
    await expect(handler({ data: JOB_DATA })).rejects.toThrow();
    expect(handleInAppDelivery).toHaveBeenCalledOnce();
  });
});
