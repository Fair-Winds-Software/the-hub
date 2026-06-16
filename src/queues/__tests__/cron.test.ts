// Authorized by HUB-161 — unit tests for CRON job registry
// Authorized by HUB-272 — promote_staged_license_changes CRON added; count updated to 3
// Authorized by HUB-336 — sdk-version-retention-cron CRON added; count updated to 4
// Authorized by HUB-517 — grace-period-expiry-scanner CRON added; count updated to 5
// Authorized by HUB-644 — periodic_margin_review CRON added; count updated to 6
// Authorized by HUB-672 — period_cost_aggregator CRON added; count updated to 7
// Authorized by HUB-787 — escalation_scanner CRON added; count updated to 8
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock queue factories ──────────────────────────────────────────────────────
const mockRemoveRepeatable = vi.fn().mockResolvedValue(true);
const mockAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueue = { name: 'queue:batch-sweep', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue2 = { name: 'queue:license-check', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue3 = { name: 'queue:grace-period-expiry-scanner', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue4 = { name: 'queue:margin-review', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue5 = { name: 'queue:billing:period-aggregation', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue6 = { name: 'queue:escalation:scanner', removeRepeatable: mockRemoveRepeatable, add: mockAdd };

vi.mock('../index.js', () => ({
  getBatchSweepQueue: vi.fn().mockReturnValue(mockQueue),
  getLicenseCheckQueue: vi.fn().mockReturnValue(mockQueue2),
  getGracePeriodExpiryScannerQueue: vi.fn().mockReturnValue(mockQueue3),
  getMarginReviewQueue: vi.fn().mockReturnValue(mockQueue4),
  getPeriodCostAggregatorQueue: vi.fn().mockReturnValue(mockQueue5),
  getEscalationScannerQueue: vi.fn().mockReturnValue(mockQueue6),
  getAllQueueDefinitions: vi.fn().mockReturnValue([]),
  registerQueue: vi.fn(),
  getDlqQueue: vi.fn(),
}));

vi.mock('../../config/decisions.js', () => ({
  TODO_D_DEF_001_INTERVAL: '7 days',
  D_002_PROMOTION_CRON: '0 0 * * *',
  TODO_D_DEF_002_INTERVAL: null,
  D_003_RETENTION_CRON: '0 0 * * *',
  D_004_GRACE_PERIOD_SCANNER_CRON: '0 * * * *',
  D_005_MARGIN_REVIEW_CRON: '0 2 * * *',
  D_006_PERIOD_COST_AGGREGATOR_CRON: '0 0 1 * *',
  D_007_ESCALATION_SCANNER_CRON: '*/5 * * * *',
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

    // One removeRepeatable per CRON definition (before each add) — now 8 definitions
    expect(mockRemoveRepeatable).toHaveBeenCalledTimes(8);
    expect(mockAdd).toHaveBeenCalledTimes(8);

    // Verify the cron pattern is passed to removeRepeatable for batch-sweep
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'batch-sweep-daily',
      expect.objectContaining({ pattern: '0 0 * * *' }),
    );
    // Verify promote_staged_license_changes is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'promote_staged_license_changes',
      expect.objectContaining({ pattern: '0 0 * * *' }),
    );
    // Verify sdk-version-retention-cron is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'sdk-version-retention-cron',
      expect.objectContaining({ pattern: '0 0 * * *' }),
    );
    // Verify grace-period-expiry-scanner is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'grace-period-expiry-scanner',
      expect.objectContaining({ pattern: '0 * * * *' }),
    );
    // Verify periodic_margin_review is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'periodic_margin_review',
      expect.objectContaining({ pattern: '0 2 * * *' }),
    );
    // Verify period_cost_aggregator is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'period_cost_aggregator',
      expect.objectContaining({ pattern: '0 0 1 * *' }),
    );
    // Verify escalation_scanner is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'escalation_scanner',
      expect.objectContaining({ pattern: '*/5 * * * *' }),
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

    // 7 remaining CRONs were still attempted despite first failing
    expect(mockAdd).toHaveBeenCalledTimes(7);
  });

  it('registers all defined CRONs when CRON_ENABLED is not set', async () => {
    const { registerAllCronJobs } = await import('../cron.js');
    await registerAllCronJobs();
    // 8 CRON definitions: batch-sweep + license-check-hourly + promote_staged_license_changes + sdk-version-retention-cron + grace-period-expiry-scanner + periodic_margin_review + period_cost_aggregator + escalation_scanner
    expect(mockAdd).toHaveBeenCalledTimes(8);
  });
});
