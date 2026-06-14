// Authorized by HUB-127 — unit tests for worker scaffold: createWorkers, gracefulShutdown
// Authorized by HUB-147 — processor-less filter and DLQ routing
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueueDefinition } from '../index.js';

// Mock BullMQ Worker so tests never need a real Redis connection
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name: string) => ({
    name,
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

// Mock Redis client — no real connection attempted
vi.mock('../../redis/client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({ status: 'ready' }),
}));

// Queue registry mock — controllable from tests
const mockDefinitions: QueueDefinition[] = [];
vi.mock('../index.js', () => ({
  getAllQueueDefinitions: vi.fn(() => [...mockDefinitions]),
  registerQueue: vi.fn((def: QueueDefinition) => mockDefinitions.push(def)),
  getDlqQueue: vi.fn().mockReturnValue({ add: vi.fn().mockResolvedValue(undefined) }),
}));

// sanitize mock — pure fn, no need for real implementation in worker tests
vi.mock('../../utils/sanitize.js', () => ({
  sanitizePayload: vi.fn((obj: unknown) => obj),
}));

// cron mock — entry-point only; not exercised in unit tests
vi.mock('../cron.js', () => ({
  registerAllCronJobs: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  mockDefinitions.length = 0;
  vi.clearAllMocks();
  delete process.env.WORKER_CONCURRENCY_TEST_QUEUE;
});

// ── Queue registry ───────────────────────────────────────────────────────────

describe('getAllQueueDefinitions()', () => {
  it('returns empty array when no queues are registered', async () => {
    const { getAllQueueDefinitions } = await import('../index.js');
    expect(getAllQueueDefinitions()).toEqual([]);
  });
});

// ── createWorkers ─────────────────────────────────────────────────────────────

describe('createWorkers()', () => {
  it('returns empty array when no queues are defined', async () => {
    const { createWorkers } = await import('../../worker.js');
    const workers = createWorkers();
    expect(workers).toHaveLength(0);
  });

  it('skips processor-less definitions (DLQ sentinel)', async () => {
    const { getAllQueueDefinitions } = await import('../index.js');
    vi.mocked(getAllQueueDefinitions).mockReturnValue([
      { name: 'alpha', concurrency: 2 },           // no processor — skipped
      { name: 'beta', concurrency: 5, processor: vi.fn() }, // has processor — included
    ]);

    const { createWorkers } = await import('../../worker.js');
    const workers = createWorkers();
    expect(workers).toHaveLength(1);
  });

  it('creates one BullMQ Worker per queue definition that has a processor', async () => {
    const { getAllQueueDefinitions } = await import('../index.js');
    vi.mocked(getAllQueueDefinitions).mockReturnValue([
      { name: 'alpha', concurrency: 2, processor: vi.fn() },
      { name: 'beta', concurrency: 5, processor: vi.fn() },
    ]);

    const { createWorkers } = await import('../../worker.js');
    const workers = createWorkers();
    expect(workers).toHaveLength(2);
  });

  it('respects WORKER_CONCURRENCY_<QUEUE> env override', async () => {
    const { Worker } = await import('bullmq');
    const { getAllQueueDefinitions } = await import('../index.js');
    vi.mocked(getAllQueueDefinitions).mockReturnValue([
      { name: 'test-queue', concurrency: 2, processor: vi.fn() },
    ]);
    process.env.WORKER_CONCURRENCY_TEST_QUEUE = '10';

    const { createWorkers } = await import('../../worker.js');
    createWorkers();

    // Worker was constructed with concurrency=10 (override), not 2 (default)
    expect(Worker).toHaveBeenCalledWith(
      'test-queue',
      expect.any(Function),
      expect.objectContaining({ concurrency: 10 }),
    );
  });
});

// ── gracefulShutdown ──────────────────────────────────────────────────────────

describe('gracefulShutdown()', () => {
  it('calls close() on all workers and exits with 0', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const mockWorkers = [
      { close: vi.fn().mockResolvedValue(undefined) },
      { close: vi.fn().mockResolvedValue(undefined) },
    ];

    const { gracefulShutdown } = await import('../../worker.js');
    await gracefulShutdown(mockWorkers as never);

    expect(mockWorkers[0].close).toHaveBeenCalled();
    expect(mockWorkers[1].close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it('exits with 1 if drain exceeds 30s timeout', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const neverResolves = new Promise<void>(() => {});
    const mockWorkers = [{ close: vi.fn().mockReturnValue(neverResolves) }];

    const { gracefulShutdown } = await import('../../worker.js');
    const shutdownPromise = gracefulShutdown(mockWorkers as never);

    vi.advanceTimersByTime(30_001);
    await shutdownPromise;

    expect(exitSpy).toHaveBeenCalledWith(1);

    vi.useRealTimers();
    exitSpy.mockRestore();
  });
});
