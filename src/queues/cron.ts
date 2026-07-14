// Authorized by HUB-161 — CRON job registry; idempotent BullMQ repeatable job registration
// Authorized by HUB-272 — promote_staged_license_changes CRON entry; D-002 billing cycle boundary
// Authorized by HUB-336 — sdk-version-retention-cron CRON entry; D-003 retention interval
// Authorized by HUB-517 — grace-period-expiry-scanner CRON entry; D-004 expiry scan interval
// Authorized by HUB-644 — periodic_margin_review CRON entry; D-005 daily margin evaluation
// Authorized by HUB-672 — period_cost_aggregator CRON entry; D-006 monthly cost aggregation
// Authorized by HUB-787 — escalation_scanner CRON entry; D-007 5-minute escalation scan interval
// Authorized by HUB-1043 — compliance_evaluation CRON entry; D-008 daily evaluation at 03:00 UTC
// Authorized by HUB-1354 — human_escalation CRON entry; D-009 daily human overdue reminders at 08:00 UTC
// Authorized by HUB-1355 — drift_detection CRON entry; D-010 daily drift detection at 04:00 UTC
// Authorized by HUB-1145 — plan_advisor CRON entry; D-011 weekly plan advisor Monday 02:00 UTC
// Authorized by HUB-1524 — retention_monthly CRON entry: 3am on 1st of month
// Authorized by HUB-1707 — role_rename_compat_flip CRON entry: 5-min tick; conditionally
//   skipped at registration when settings.role_rename_compat_window_enabled is already
//   false, so a re-deploy after the flag has flipped does not re-arm a stale job.
import type { Queue } from 'bullmq';
import { getBatchSweepQueue, getLicenseCheckQueue, getGracePeriodExpiryScannerQueue, getMarginReviewQueue, getPeriodCostAggregatorQueue, getEscalationScannerQueue, getComplianceEvalQueue, getHumanEscalationQueue, getDriftDetectionQueue, getPlanAdvisorQueue, getRetentionMonthlyQueue, getRoleRenameCompatFlipQueue, getBiRollupQueue } from './index.js';
import { D_002_PROMOTION_CRON, D_003_RETENTION_CRON, D_004_GRACE_PERIOD_SCANNER_CRON, D_005_MARGIN_REVIEW_CRON, D_006_PERIOD_COST_AGGREGATOR_CRON, D_007_ESCALATION_SCANNER_CRON, D_008_COMPLIANCE_EVAL_CRON, D_009_HUMAN_ESCALATION_CRON, D_010_DRIFT_DETECTION_CRON, D_011_PLAN_ADVISOR_CRON } from '../config/decisions.js';
import { getSetting } from '../services/adminSettings.js';
import logger from '../lib/logger.js';

const ROLE_RENAME_COMPAT_FLIP_CRON = '*/5 * * * *';

interface CronDefinition {
  queueFactory: () => Queue;
  name: string;
  cron: string;
  payload: Record<string, unknown>;
}

// Authoritative list of all scheduled work in the HUB.
// Adding a new scheduled job = one entry here + one queue factory in src/queues/index.ts.
const CRON_DEFINITIONS: CronDefinition[] = [
  {
    queueFactory: getBatchSweepQueue,
    name: 'batch-sweep-daily',
    cron: '0 0 * * *',
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getLicenseCheckQueue,
    name: 'license-check-hourly',
    cron: '0 * * * *',
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getLicenseCheckQueue,
    name: 'promote_staged_license_changes',
    cron: D_002_PROMOTION_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getBatchSweepQueue,
    name: 'sdk-version-retention-cron',
    cron: D_003_RETENTION_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getGracePeriodExpiryScannerQueue,
    name: 'grace-period-expiry-scanner',
    cron: D_004_GRACE_PERIOD_SCANNER_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getMarginReviewQueue,
    name: 'periodic_margin_review',
    cron: D_005_MARGIN_REVIEW_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getPeriodCostAggregatorQueue,
    name: 'period_cost_aggregator',
    cron: D_006_PERIOD_COST_AGGREGATOR_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getEscalationScannerQueue,
    name: 'escalation_scanner',
    cron: D_007_ESCALATION_SCANNER_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getComplianceEvalQueue,
    name: 'compliance_evaluation',
    cron: D_008_COMPLIANCE_EVAL_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getHumanEscalationQueue,
    name: 'human_escalation',
    cron: D_009_HUMAN_ESCALATION_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getDriftDetectionQueue,
    name: 'drift_detection',
    cron: D_010_DRIFT_DETECTION_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getPlanAdvisorQueue,
    name: 'plan_advisor',
    cron: D_011_PLAN_ADVISOR_CRON,
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getRetentionMonthlyQueue,
    name: 'retention_monthly',
    cron: '0 3 1 * *',
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getRoleRenameCompatFlipQueue,
    name: 'role-rename-compat-flip',
    cron: ROLE_RENAME_COMPAT_FLIP_CRON,
    payload: { triggered: 'scheduled' },
  },
  // HUB-1806 (S4 of HUB-1785) — BI rollup CRONs.
  //   hourly:  5 min after every hour ("give ingestion buffer for the just-closed hour")
  //   daily:   00:10 UTC — 10 min after UTC midnight so any straggler events land
  //   monthly: 03:15 UTC on the 1st of the month
  {
    queueFactory: getBiRollupQueue,
    name: 'bi_rollup_hourly',
    cron: '5 * * * *',
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getBiRollupQueue,
    name: 'bi_rollup_daily',
    cron: '10 0 * * *',
    payload: { triggered: 'scheduled' },
  },
  {
    queueFactory: getBiRollupQueue,
    name: 'bi_rollup_monthly',
    cron: '15 3 1 * *',
    payload: { triggered: 'scheduled' },
  },
];

export async function registerAllCronJobs(): Promise<void> {
  if (process.env.CRON_ENABLED === 'false') {
    logger.info('CRON_ENABLED=false — skipping CRON registration');
    return;
  }

  let registered = 0;

  // HUB-1707: skip re-registering the compat-flip job once the flag has already flipped
  // to false. Cheaper than the alternative (job fires every 5 min forever, exits early
  // on flag=false) and matches the ticket's "does not re-arm a stale job" requirement.
  const roleRenameCompatFlagEnabled = await getSetting('role_rename_compat_window_enabled').catch(() => true);

  for (const def of CRON_DEFINITIONS) {
    if (def.name === 'role-rename-compat-flip' && roleRenameCompatFlagEnabled !== true) {
      logger.info(
        { job: def.name },
        'role_rename_compat_window_enabled=false — skipping compat-flip CRON registration',
      );
      continue;
    }

    try {
      const queue = def.queueFactory();

      // Remove existing repeatable before re-adding — prevents duplication on worker restart
      await queue.removeRepeatable(def.name, { pattern: def.cron });

      await queue.add(def.name, def.payload, {
        repeat: { pattern: def.cron },
      });

      logger.info({ job: def.name, cron: def.cron, queue: queue.name }, 'CRON job registered');
      registered++;
    } catch (err) {
      logger.error({ job: def.name, err }, 'CRON registration failed — continuing with remaining');
    }
  }

  logger.info({ registered, total: CRON_DEFINITIONS.length }, 'CRON registration complete');
}
