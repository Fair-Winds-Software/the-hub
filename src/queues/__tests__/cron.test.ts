// Authorized by HUB-161 — unit tests for CRON job registry
// Authorized by HUB-272 — promote_staged_license_changes CRON added; count updated to 3
// Authorized by HUB-336 — sdk-version-retention-cron CRON added; count updated to 4
// Authorized by HUB-517 — grace-period-expiry-scanner CRON added; count updated to 5
// Authorized by HUB-644 — periodic_margin_review CRON added; count updated to 6
// Authorized by HUB-672 — period_cost_aggregator CRON added; count updated to 7
// Authorized by HUB-787 — escalation_scanner CRON added; count updated to 8
// Authorized by HUB-1043 — compliance_evaluation CRON added; count updated to 9
// Authorized by HUB-1354 — human_escalation CRON added; count updated to 10
// Authorized by HUB-1355 — drift_detection CRON added; count updated to 11
// Authorized by HUB-1145 — plan_advisor CRON added; count updated to 12
// Authorized by HUB-1524 — retention_monthly CRON added; count updated to 13
// Authorized by HUB-1707 — role-rename-compat-flip CRON added; count updated to 14
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock queue factories ──────────────────────────────────────────────────────
const mockRemoveRepeatable = vi.fn().mockResolvedValue(true);
const mockAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueue = { name: 'batch-sweep', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue2 = { name: 'license-check', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue3 = { name: 'grace-period-expiry-scanner', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue4 = { name: 'margin-review', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue5 = { name: 'billing.period-aggregation', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue6 = { name: 'escalation.scanner', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue7 = { name: 'compliance.evaluation', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue8 = { name: 'compliance.human-escalation', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue9 = { name: 'compliance.drift-detection', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue10 = { name: 'advisor.weekly', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue11 = { name: 'retention.monthly', removeRepeatable: mockRemoveRepeatable, add: mockAdd };
const mockQueue12 = { name: 'role-rename-compat-flip', removeRepeatable: mockRemoveRepeatable, add: mockAdd };

vi.mock('../index.js', () => ({
  getBatchSweepQueue: vi.fn().mockReturnValue(mockQueue),
  getLicenseCheckQueue: vi.fn().mockReturnValue(mockQueue2),
  getGracePeriodExpiryScannerQueue: vi.fn().mockReturnValue(mockQueue3),
  getMarginReviewQueue: vi.fn().mockReturnValue(mockQueue4),
  getPeriodCostAggregatorQueue: vi.fn().mockReturnValue(mockQueue5),
  getEscalationScannerQueue: vi.fn().mockReturnValue(mockQueue6),
  getComplianceEvalQueue: vi.fn().mockReturnValue(mockQueue7),
  getHumanEscalationQueue: vi.fn().mockReturnValue(mockQueue8),
  getDriftDetectionQueue: vi.fn().mockReturnValue(mockQueue9),
  getPlanAdvisorQueue: vi.fn().mockReturnValue(mockQueue10),
  getRetentionMonthlyQueue: vi.fn().mockReturnValue(mockQueue11),
  getRoleRenameCompatFlipQueue: vi.fn().mockReturnValue(mockQueue12),
  getAllQueueDefinitions: vi.fn().mockReturnValue([]),
  registerQueue: vi.fn(),
  getDlqQueue: vi.fn(),
}));

// HUB-1707: cron.ts now consults role_rename_compat_window_enabled before registering
// the compat-flip CRON. Default the mock to true so existing tests see all CRONs registered.
const mockGetSetting = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../../services/adminSettings.js', () => ({
  getSetting: mockGetSetting,
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
  D_008_COMPLIANCE_EVAL_CRON: '0 3 * * *',
  D_009_HUMAN_ESCALATION_CRON: '0 8 * * *',
  D_010_DRIFT_DETECTION_CRON: '0 4 * * *',
  D_011_PLAN_ADVISOR_CRON: '0 2 * * 1',
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

    // One removeRepeatable per CRON definition (before each add) — now 14 definitions
    expect(mockRemoveRepeatable).toHaveBeenCalledTimes(14);
    expect(mockAdd).toHaveBeenCalledTimes(14);

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
    // Verify compliance_evaluation is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'compliance_evaluation',
      expect.objectContaining({ pattern: '0 3 * * *' }),
    );
    // Verify human_escalation is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'human_escalation',
      expect.objectContaining({ pattern: '0 8 * * *' }),
    );
    // Verify drift_detection is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'drift_detection',
      expect.objectContaining({ pattern: '0 4 * * *' }),
    );
    // Verify plan_advisor is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'plan_advisor',
      expect.objectContaining({ pattern: '0 2 * * 1' }),
    );
    // Verify retention_monthly is also registered
    expect(mockRemoveRepeatable).toHaveBeenCalledWith(
      'retention_monthly',
      expect.objectContaining({ pattern: '0 3 1 * *' }),
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

    // 13 remaining CRONs were still attempted despite first failing (14 total minus 1 failure)
    expect(mockAdd).toHaveBeenCalledTimes(13);
  });

  it('registers all defined CRONs when CRON_ENABLED is not set', async () => {
    const { registerAllCronJobs } = await import('../cron.js');
    await registerAllCronJobs();
    // 14 CRON definitions: batch-sweep + license-check-hourly + promote_staged_license_changes + sdk-version-retention-cron + grace-period-expiry-scanner + periodic_margin_review + period_cost_aggregator + escalation_scanner + compliance_evaluation + human_escalation + drift_detection + plan_advisor + retention_monthly + role-rename-compat-flip
    expect(mockAdd).toHaveBeenCalledTimes(14);
  });
});
