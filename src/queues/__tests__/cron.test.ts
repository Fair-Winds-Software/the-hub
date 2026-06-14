// Authorized by HUB-161 — unit tests for CRON job registry
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock queue factories ──────────────────────────────────────────────────────
const mockRemoveRepeatable = vi.fn().mockResolvedValue(true);
const mockAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueue = { name: 'queue:batch-sweep', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue2 = { name: 'queue:license-check', removeRepeatable: mockRemoveRepeatable, add: mockAdd };

vi.mock('../index.js', () => ({
  getBatchSweepQueue: vi.fn().mockReturnValue(mockQueue),
  getLicenseCheckQueue: vi.fn().mockReturnValue(mockQueue2),
  getAllQueueDefinitions: vi.fn().mockReturnValue([]),
  registerQueue: vi.fn(),
  getDlqQueue: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_ENABLED;
  mockRemoveRepeatable.mockResolvedValue(true);
  mockAdd.mockResolvedValue({ id: 'job-1' });
});

// ── registerAllCronJobs ───────────────────────────────────────────────────────

describe('registerAllCronJobs()', () => {
  it('is a no-op when CRON_ENABLED=false', async () => {
    process.env.CRON_ENABLED = 'false';
    const { registerAllCronJobs } = await import('../cron.js');
    await registerAllCronJobs();
    expect(mockRemoveRepeatable).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('removes existing repeatable before adding (idempotent restart)', async () => {
    const { registerAllCronJobs } = await import('../cron.js');
    await registerAllCronJobs();

    // One removeRepeatable per CRON definition (before each add)
    expect(mockRemoveRepeatable).toHaveBeenCalledTimes(2);
    expect(mockAdd).toHaveBeenCalledTimes(2);

    // Verify the cron pattern is passed to removeRepeatable
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'batch-sweep-daily',
      expect.objectContaining({ pattern: '0 0 * * *' }),
    );
  });

  it('calls add() with repeat.pattern set to the cron expression', async () => {
    const { registerAllCronJobs } = await import('../cron.js');
    await registerAllCronJobs();
    const addCalls = mockAdd.mock.calls;
    expect(addCalls.length).toBeGreaterThan(0);
    for (const [, , opts] of addCalls) {
      expect(opts).toMatchObject({ repeat: { pattern: expect.stringMatching(/[\d*]/) } });
    }
  });

  it('continues registering remaining CRONs if one fails', async () => {
    mockRemoveRepeatable
      .mockRejectedValueOnce(new Error('Redis fail'))
      .mockResolvedValue(true);

    const { registerAllCronJobs } = await import('../cron.js');
    await expect(registerAllCronJobs()).resolves.toBeUndefined();

    // Second CRON was still attempted despite first failing
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it('registers all defined CRONs when CRON_ENABLED is not set', async () => {
    const { registerAllCronJobs } = await import('../cron.js');
    await registerAllCronJobs();
    // 2 CRON definitions: batch-sweep + license-check
    expect(mockAdd).toHaveBeenCalledTimes(2);
  });
});
