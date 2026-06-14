// Authorized by HUB-146 — unit tests for queue factory: singleton instances, definitions registry
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock BullMQ Queue — no real Redis connection
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({ name })),
  Worker: vi.fn().mockImplementation((name: string) => ({
    name,
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock Redis client
vi.mock('../../redis/client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({ status: 'ready' }),
}));

// ── Queue Factory ─────────────────────────────────────────────────────────────

describe('getBatchSweepQueue()', () => {
  it('returns a Queue with name queue:batch-sweep', async () => {
    const { getBatchSweepQueue } = await import('../index.js');
    const q = getBatchSweepQueue();
    expect(q.name).toBe('queue:batch-sweep');
  });

  it('returns the same instance on repeated calls (singleton)', async () => {
    const { getBatchSweepQueue } = await import('../index.js');
    const q1 = getBatchSweepQueue();
    const q2 = getBatchSweepQueue();
    expect(q1).toBe(q2);
  });
});

describe('getLicenseCheckQueue()', () => {
  it('returns a Queue with name queue:license-check', async () => {
    const { getLicenseCheckQueue } = await import('../index.js');
    const q = getLicenseCheckQueue();
    expect(q.name).toBe('queue:license-check');
  });

  it('returns the same instance on repeated calls (singleton)', async () => {
    const { getLicenseCheckQueue } = await import('../index.js');
    const q1 = getLicenseCheckQueue();
    const q2 = getLicenseCheckQueue();
    expect(q1).toBe(q2);
  });
});

describe('getAllQueueDefinitions()', () => {
  it('includes both concrete queue definitions', async () => {
    const { getAllQueueDefinitions } = await import('../index.js');
    const defs = getAllQueueDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain('queue:batch-sweep');
    expect(names).toContain('queue:license-check');
  });

  it('batch-sweep definition has concurrency, maxAttempts, and exponential backoff', async () => {
    const { getAllQueueDefinitions } = await import('../index.js');
    const def = getAllQueueDefinitions().find((d) => d.name === 'queue:batch-sweep')!;
    expect(def.concurrency).toBeGreaterThan(0);
    expect(def.maxAttempts).toBeGreaterThan(0);
    expect(def.backoff).toMatchObject({ type: 'exponential' });
  });

  it('license-check definition has concurrency, maxAttempts, and exponential backoff', async () => {
    const { getAllQueueDefinitions } = await import('../index.js');
    const def = getAllQueueDefinitions().find((d) => d.name === 'queue:license-check')!;
    expect(def.concurrency).toBeGreaterThan(0);
    expect(def.maxAttempts).toBeGreaterThan(0);
    expect(def.backoff).toMatchObject({ type: 'exponential' });
  });
});

describe('defaultJobOptions()', () => {
  it('maps maxAttempts to attempts and includes backoff', async () => {
    const { defaultJobOptions } = await import('../index.js');
    const opts = defaultJobOptions({ maxAttempts: 4, backoff: { type: 'exponential', delay: 2000 } });
    expect(opts.attempts).toBe(4);
    expect(opts.backoff).toMatchObject({ type: 'exponential', delay: 2000 });
  });
});
