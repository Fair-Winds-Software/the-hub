// Authorized by HUB-259 — deferrable decision sentinels; replace null when decisions resolve
// Authorized by HUB-272 — D-002 billing cycle boundary for staged license change promotion

// TODO-D-DEF-001: grace window duration after license suspension.
// Value: a PostgreSQL interval string, e.g. '7 days', '1 month'.
// Replace null (and remove the AppError guard in license.ts) when D-DEF-001 resolves.
export const TODO_D_DEF_001_INTERVAL: string | null = null;

// D-002: CRON expression for billing cycle boundary promotion of staged license changes.
// Overridable via PROMOTE_STAGED_CRON env var. Defaults to daily midnight until D-002 resolves.
export const D_002_PROMOTION_CRON: string =
  process.env.PROMOTE_STAGED_CRON ?? '0 0 * * *';
