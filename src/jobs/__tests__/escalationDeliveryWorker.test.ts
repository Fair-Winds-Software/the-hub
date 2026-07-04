// Authorized by HUB-808 — unit tests: escalation delivery worker; email/webhook/sms/unknown dispatch; failure accumulation; DLQ warn
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWorkerOn = vi.hoisted(() => vi.fn());
const mockWorkerConstructor = vi.hoisted(() => vi.fn());
vi.mock('bullmq', () => ({
  Worker: mockWorkerConstructor,
}));

vi.mock('../../redis/client.js', () => ({
  getRedisClientForBullMQ: vi.fn().mockReturnValue({}),
}));

const mockSendMail = vi.hoisted(() => vi.fn());
const mockCreateTransport = vi.hoisted(() => vi.fn());
vi.mock('nodemailer', () => ({
  default: {
    createTransport: mockCreateTransport,
  },
}));

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerEscalationDeliveryWorker } from '../escalationDeliveryWorker.js';
import logger from '../../lib/logger.js';

const ALERT_EVENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_ID      = 'bbbbbbbb-0000-0000-0000-000000000002';
const PRODUCT_ID     = 'cccccccc-0000-0000-0000-000000000003';

function makeJobData(contacts: Array<{ type: string; value: string }>) {
  return {
    data: {
      alertEventId: ALERT_EVENT_ID,
      tier: 1,
      contacts,
      alertType: 'below_floor',
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
    },
  };
}

function captureHandler(): (job: ReturnType<typeof makeJobData>) => Promise<void> {
  return mockWorkerConstructor.mock.calls[0]?.[1] as (job: ReturnType<typeof makeJobData>) => Promise<void>;
}

function captureFailedListener(): (job: unknown, err: Error) => void {
  const call = mockWorkerOn.mock.calls.find(([event]) => event === 'failed');
  return call?.[1] as (job: unknown, err: Error) => void;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockWorkerConstructor.mockImplementation(() => ({ on: mockWorkerOn }));
  mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });
  process.env.EMAIL_HOST = 'smtp.example.com';
  mockSendMail.mockResolvedValue({ messageId: 'msg-1' });
  mockFetch.mockResolvedValue({ ok: true });
});

describe('registerEscalationDeliveryWorker', () => {
  it('returns a Worker instance listening on correct queue', () => {
    const worker = registerEscalationDeliveryWorker();
    expect(worker).toBeDefined();
    expect(mockWorkerConstructor.mock.calls[0]![0]).toBe('escalation.deliver');
  });

  it('registers on(failed) listener', () => {
    registerEscalationDeliveryWorker();
    expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('sends email for email contact', async () => {
    registerEscalationDeliveryWorker();
    const handler = captureHandler();
    await handler(makeJobData([{ type: 'email', value: 'oncall@example.com' }]));
    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0]![0] as Record<string, string>;
    expect(call.to).toBe('oncall@example.com');
    expect(call.subject).toContain('Tier 1');
    expect(call.subject).toContain('below_floor');
  });

  it('throws when EMAIL_HOST is not configured', async () => {
    delete process.env.EMAIL_HOST;
    registerEscalationDeliveryWorker();
    const handler = captureHandler();
    await expect(handler(makeJobData([{ type: 'email', value: 'oncall@example.com' }]))).rejects.toThrow('Email handler not configured');
  });

  it('calls fetch for webhook contact', async () => {
    registerEscalationDeliveryWorker();
    const handler = captureHandler();
    await handler(makeJobData([{ type: 'webhook', value: 'https://hooks.example.com/alert' }]));
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/alert');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.event).toBe('escalation');
    expect(body.tier).toBe(1);
  });

  it('throws when webhook returns non-ok status', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    registerEscalationDeliveryWorker();
    const handler = captureHandler();
    await expect(handler(makeJobData([{ type: 'webhook', value: 'https://hooks.example.com' }]))).rejects.toThrow('Escalation webhook delivery failed');
  });

  it('logs warn for sms contact (not implemented)', async () => {
    registerEscalationDeliveryWorker();
    const handler = captureHandler();
    await handler(makeJobData([{ type: 'sms', value: '+15555551234' }]));
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toMatchObject({ contactType: 'sms' });
  });

  it('logs warn for unknown contact type', async () => {
    registerEscalationDeliveryWorker();
    const handler = captureHandler();
    await handler(makeJobData([{ type: 'fax', value: '555-1234' }]));
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toMatchObject({ contactType: 'fax' });
  });

  it('attempts all contacts even when earlier ones fail', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP error'));
    registerEscalationDeliveryWorker();
    const handler = captureHandler();
    await expect(
      handler(makeJobData([
        { type: 'email', value: 'oncall@example.com' },
        { type: 'webhook', value: 'https://hooks.example.com' },
      ]))
    ).rejects.toThrow();
    // webhook must still have been called
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('rethrows the last failure when any contact fails', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('first failure'));
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    registerEscalationDeliveryWorker();
    const handler = captureHandler();
    await expect(
      handler(makeJobData([
        { type: 'email', value: 'oncall@example.com' },
        { type: 'webhook', value: 'https://hooks.example.com' },
      ]))
    ).rejects.toThrow('Escalation webhook delivery failed');
  });

  it('logs error on failed listener when attempts exhausted', () => {
    registerEscalationDeliveryWorker();
    const onFailed = captureFailedListener();
    const fakeJob = {
      id: 'job-1',
      opts: { attempts: 3 },
      attemptsMade: 3,
      data: { alertEventId: ALERT_EVENT_ID, tier: 1 },
    };
    onFailed(fakeJob, new Error('exhausted'));
    expect(vi.mocked(logger.error)).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.error).mock.calls[0]![0]).toMatchObject({ event: 'escalation-dlq' });
  });

  it('skips DLQ log on failed listener when not yet exhausted', () => {
    registerEscalationDeliveryWorker();
    const onFailed = captureFailedListener();
    const fakeJob = {
      id: 'job-2',
      opts: { attempts: 3 },
      attemptsMade: 1,
      data: { alertEventId: ALERT_EVENT_ID, tier: 1 },
    };
    onFailed(fakeJob, new Error('transient'));
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });
});
