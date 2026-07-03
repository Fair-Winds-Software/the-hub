// Authorized by HUB-1545 (System Health spec-deviation close-out) —
// unit tests for reflectStripeWebhookRetry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

const mockPoolQuery = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [] }));
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

import { reflectStripeWebhookRetry } from '../stripeWebhookRetryReflector.js';

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: 'j-1',
    data: { event_id: 'evt_1' },
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 500 } },
    attemptsMade: 1,
    ...overrides,
  } as unknown as Job;
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('reflectStripeWebhookRetry', () => {
  it('writes pending_retry + a next_retry_at when attempts remain', async () => {
    await reflectStripeWebhookRetry(makeJob({}), false);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toContain("status = 'pending_retry'");
    expect(params[0]).toBe('evt_1');
    expect(params[1]).toBeInstanceOf(Date);
  });

  it('writes failed + clears next_retry_at when attempts are exhausted', async () => {
    await reflectStripeWebhookRetry(makeJob({ attemptsMade: 3 }), true);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain('next_retry_at = NULL');
    expect(params[0]).toBe('evt_1');
  });

  it('no-ops when the job payload has no event_id', async () => {
    await reflectStripeWebhookRetry(
      makeJob({ data: {} as Record<string, unknown> }),
      false,
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('computes exponential backoff delay from attemptsMade', async () => {
    const before = Date.now();
    await reflectStripeWebhookRetry(
      makeJob({
        attemptsMade: 2,
        opts: { attempts: 5, backoff: { type: 'exponential', delay: 500 } },
      }),
      false,
    );
    const after = Date.now();
    const params = mockPoolQuery.mock.calls[0]![1] as [string, Date];
    const nextRetryAt = params[1].getTime();
    // 500 * 2^2 = 2000ms
    expect(nextRetryAt).toBeGreaterThanOrEqual(before + 2000);
    expect(nextRetryAt).toBeLessThanOrEqual(after + 2000);
  });
});
