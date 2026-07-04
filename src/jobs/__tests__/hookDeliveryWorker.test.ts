// Authorized by HUB-829 — unit tests: registerHookDeliveryWorker(); fan-out; pending/delivered/failed status; DLQ warn
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockFindMatchingHooks = vi.hoisted(() => vi.fn());
vi.mock('../../services/hookMatchingService.js', () => ({
  findMatchingHooks: mockFindMatchingHooks,
}));

const mockDeliverHook = vi.hoisted(() => vi.fn());
vi.mock('../../services/hookDeliveryService.js', () => ({
  deliverHook: mockDeliverHook,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerHookDeliveryWorker } from '../hookDeliveryWorker.js';
import logger from '../../lib/logger.js';

const TENANT_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const HOOK_ID    = 'cccccccc-0000-0000-0000-000000000003';
const EXEC_ID    = 'dddddddd-0000-0000-0000-000000000004';

const SAMPLE_HOOK = {
  id: HOOK_ID,
  tenant_id: TENANT_ID,
  product_id: PRODUCT_ID,
  trigger_event_type: 'alert.fired',
  action_type: 'webhook',
  action_config: { url: 'https://hooks.example.com', hmac_secret: 'enc' },
  enabled: true,
  created_at: new Date().toISOString(),
};

const JOB_DATA = {
  eventType: 'alert.fired',
  tenantId: TENANT_ID,
  productId: PRODUCT_ID,
  payload: { alertId: 'a1' },
};

function captureHandler(): (job: { data: typeof JOB_DATA }) => Promise<void> {
  return mockWorkerConstructor.mock.calls[0]?.[1] as (job: { data: typeof JOB_DATA }) => Promise<void>;
}

function captureFailedListener(): (job: unknown, err: Error) => void {
  const call = mockWorkerOn.mock.calls.find(([event]) => event === 'failed');
  return call?.[1] as (job: unknown, err: Error) => void;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockWorkerConstructor.mockImplementation(() => ({ on: mockWorkerOn }));
  mockDeliverHook.mockResolvedValue({ statusCode: 200, durationMs: 50 });
  mockPoolQuery.mockResolvedValue({ rows: [{ id: EXEC_ID }], rowCount: 1 });
});

describe('registerHookDeliveryWorker', () => {
  it('returns a Worker on workflow.hook', () => {
    registerHookDeliveryWorker();
    expect(mockWorkerConstructor.mock.calls[0]![0]).toBe('workflow.hook');
  });

  it('registers on(failed) listener for DLQ warn', () => {
    registerHookDeliveryWorker();
    expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('returns early and writes nothing when no hooks match', async () => {
    mockFindMatchingHooks.mockResolvedValueOnce([]);
    registerHookDeliveryWorker();
    await captureHandler()({ data: JOB_DATA });
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockDeliverHook).not.toHaveBeenCalled();
  });

  it('inserts pending execution row before delivering', async () => {
    mockFindMatchingHooks.mockResolvedValueOnce([SAMPLE_HOOK]);
    registerHookDeliveryWorker();
    await captureHandler()({ data: JOB_DATA });
    const firstCall = mockPoolQuery.mock.calls[0]![0] as string;
    expect(firstCall).toContain("'pending'");
  });

  it('updates execution to delivered on success', async () => {
    mockFindMatchingHooks.mockResolvedValueOnce([SAMPLE_HOOK]);
    registerHookDeliveryWorker();
    await captureHandler()({ data: JOB_DATA });
    const updateCall = mockPoolQuery.mock.calls[1]![0] as string;
    expect(updateCall).toContain("'delivered'");
  });

  it('updates execution to failed and rethrows on delivery error', async () => {
    mockFindMatchingHooks.mockResolvedValueOnce([SAMPLE_HOOK]);
    mockDeliverHook.mockRejectedValueOnce(new Error('timeout'));
    registerHookDeliveryWorker();
    await expect(captureHandler()({ data: JOB_DATA })).rejects.toThrow('timeout');
    const updateCall = mockPoolQuery.mock.calls[1]![0] as string;
    expect(updateCall).toContain("'failed'");
  });

  it('attempts all hooks even when earlier one fails', async () => {
    const hook2 = { ...SAMPLE_HOOK, id: 'hook-2' };
    mockFindMatchingHooks.mockResolvedValueOnce([SAMPLE_HOOK, hook2]);
    mockDeliverHook
      .mockRejectedValueOnce(new Error('fail hook 1'))
      .mockResolvedValueOnce({ statusCode: 200, durationMs: 30 });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: EXEC_ID }] })      // insert pending hook 1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // update failed hook 1
      .mockResolvedValueOnce({ rows: [{ id: 'exec-2' }] })      // insert pending hook 2
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });         // update delivered hook 2
    registerHookDeliveryWorker();
    await expect(captureHandler()({ data: JOB_DATA })).rejects.toThrow('fail hook 1');
    expect(mockDeliverHook).toHaveBeenCalledTimes(2);
  });

  it('emits Pino warn on failed listener when attempts exhausted', () => {
    registerHookDeliveryWorker();
    const onFailed = captureFailedListener();
    onFailed(
      { id: 'job-1', opts: { attempts: 3 }, attemptsMade: 3, data: JOB_DATA },
      new Error('exhausted'),
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn).mock.calls[0]![0]).toMatchObject({ event: 'hook-dlq' });
  });

  it('skips DLQ warn on failed listener when not yet exhausted', () => {
    registerHookDeliveryWorker();
    const onFailed = captureFailedListener();
    onFailed(
      { id: 'job-2', opts: { attempts: 3 }, attemptsMade: 1, data: JOB_DATA },
      new Error('transient'),
    );
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});
