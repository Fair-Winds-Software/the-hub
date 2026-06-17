// Authorized by HUB-259 — deferrable decision sentinels; replace null when decisions resolve
// Authorized by HUB-272 — D-002 billing cycle boundary for staged license change promotion
// Authorized by HUB-336 — D-003 SDK version report retention interval and CRON expression
// Authorized by HUB-517 — D-004 grace period expiry scanner CRON expression
// Authorized by HUB-672 — D-006: CRON expression for monthly billing period cost aggregation

// TODO-D-DEF-001: grace window duration after license suspension.
// Value: a PostgreSQL interval string, e.g. '7 days', '1 month'.
// Replace null (and remove the AppError guard in license.ts) when D-DEF-001 resolves.
export const TODO_D_DEF_001_INTERVAL: string | null = null;

// D-002: CRON expression for billing cycle boundary promotion of staged license changes.
// Overridable via PROMOTE_STAGED_CRON env var. Defaults to daily midnight until D-002 resolves.
export const D_002_PROMOTION_CRON: string =
  process.env.PROMOTE_STAGED_CRON ?? '0 0 * * *';

// TODO-D-DEF-002: SDK version report retention window.
// Value: a PostgreSQL interval string, e.g. '90 days', '6 months'.
// Replace null (and remove the AppError guard in versionReporting.ts) when D-DEF-002 resolves.
export const TODO_D_DEF_002_INTERVAL: string | null = null;

// D-003: CRON expression for SDK version report retention pruning.
// Overridable via SDK_VERSION_RETENTION_CRON env var. Defaults to daily midnight until D-003 resolves.
export const D_003_RETENTION_CRON: string =
  process.env.SDK_VERSION_RETENTION_CRON ?? '0 0 * * *';

// Authorized by HUB-538 — D-DEF-LEASE-RENEWAL: lease renewal cadence sentinel
// TODO-D-DEF-LEASE-RENEWAL: days before expiry at which a lease should be proactively renewed.
// Replace null (and remove the placeholder computation in leaseService.ts) when the decision resolves.
// While null, renewsAt is set equal to expiresAt (conservative: SDK renews only when expired).
export const TODO_D_LEASE_RENEWAL_DAYS: number | null = null;

// D-004: CRON expression for billing grace period expiry scanning.
// Overridable via GRACE_PERIOD_SCANNER_CRON env var. Defaults to hourly until D-004 resolves.
export const D_004_GRACE_PERIOD_SCANNER_CRON: string =
  process.env.GRACE_PERIOD_SCANNER_CRON ?? '0 * * * *';

// Authorized by HUB-644 — D-005: CRON expression for daily margin review.
// Overridable via MARGIN_REVIEW_CRON env var. Defaults to 02:00 UTC daily.
export const D_005_MARGIN_REVIEW_CRON: string =
  process.env.MARGIN_REVIEW_CRON ?? '0 2 * * *';

// D-006: CRON expression for monthly billing period cost aggregation (E16).
// Overridable via PERIOD_COST_AGGREGATOR_CRON env var. Defaults to first of month midnight UTC.
export const D_006_PERIOD_COST_AGGREGATOR_CRON: string =
  process.env.PERIOD_COST_AGGREGATOR_CRON ?? '0 0 1 * *';

// Authorized by HUB-787 — D-007: CRON expression for escalation scanner (E20).
// Overridable via ESCALATION_SCANNER_CRON env var. Defaults to every 5 minutes.
export const D_007_ESCALATION_SCANNER_CRON: string =
  process.env.ESCALATION_SCANNER_CRON ?? '*/5 * * * *';

// Authorized by HUB-1043 — D-008: CRON expression for compliance evaluation runner (E35).
// Overridable via COMPLIANCE_EVAL_CRON env var. Defaults to 03:00 UTC daily.
export const D_008_COMPLIANCE_EVAL_CRON: string =
  process.env.COMPLIANCE_EVAL_CRON ?? '0 3 * * *';
