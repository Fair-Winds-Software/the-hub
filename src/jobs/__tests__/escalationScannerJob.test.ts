// Authorized by HUB-787 — unit tests: registerEscalationScannerJob(); worker creation; overrun warn; error rethrow
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWorkerOn = vi.hoisted(() => vi.fn());
const mockWorkerConstructor = vi.hoisted(() => vi.fn());
vi.mock('bullmq', () => ({
  Worker: mockWorkerConstructor,
}));

vi.mock('../../redis/client.js', () => ({
  getRedisClientForBullMQ: vi.fn().mockReturnValue({}),
}));

const mockRunEscalationScan = vi.hoisted(() => vi.fn());
vi.mock('../../services/escalationService.js', () => ({
  runEscalationScan: mockRunEscalationScan,
}));

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerEscalationScannerJob } from '../escalationScannerJob.js';
import logger from '../../lib/logger.js';

function captureHandler(): (job: unknown) => Promise<void> {
  return mockWorkerConstructor.mock.calls[0]?.[1] as (job: unknown) => Promise<void>;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockWorkerConstructor.mockImplementation(() => ({ on: mockWorkerOn }));
});

describe('registerEscalationScannerJob', () => {
  it('returns a Worker instance', () => {
    const worker = registerEscalationScannerJob();
    expect(worker).toBeDefined();
    expect(mockWorkerConstructor).toHaveBeenCalledOnce();
    expect(mockWorkerConstructor.mock.calls[0]![0]).toBe('escalation.scanner');
  });

  it('logs info on successful tick', async () => {
    mockRunEscalationScan.mockResolvedValueOnce({ scanned: 3, escalated: 1 });
    registerEscalationScannerJob();
    await captureHandler()({});
    expect(vi.mocked(logger.info)).toHaveBeenCalledOnce();
    const [meta] = vi.mocked(logger.info).mock.calls[0]!;
    expect(meta).toMatchObject({ escalationsFound: 1, scanned: 3 });
  });

  it('logs warn when elapsed_ms exceeds 30s', async () => {
    let callCount = 0;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      // first call = startTime, second call = elapsed check
      return callCount++ === 0 ? 0 : 31_000;
    });
    mockRunEscalationScan.mockResolvedValueOnce({ scanned: 0, escalated: 0 });
    registerEscalationScannerJob();
    await captureHandler()({});
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce();
    const [meta] = vi.mocked(logger.warn).mock.calls[0]!;
    expect((meta as Record<string, unknown>).elapsed_ms).toBeGreaterThan(30_000);
    vi.spyOn(Date, 'now').mockRestore();
    Date.now = realNow;
  });

  it('does NOT warn when elapsed_ms is within 30s', async () => {
    mockRunEscalationScan.mockResolvedValueOnce({ scanned: 0, escalated: 0 });
    registerEscalationScannerJob();
    await captureHandler()({});
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('logs error and rethrows when runEscalationScan rejects', async () => {
    const boom = new Error('DB down');
    mockRunEscalationScan.mockRejectedValueOnce(boom);
    registerEscalationScannerJob();
    await expect(captureHandler()({})).rejects.toThrow('DB down');
    expect(vi.mocked(logger.error)).toHaveBeenCalledOnce();
  });
});
