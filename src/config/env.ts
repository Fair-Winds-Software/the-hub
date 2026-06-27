// Authorized by HUB-77 — startup env var validation; logs missing var names only, never values
// Authorized by HUB-1525 — LEASE_ENCRYPTION_KEY (≥32 bytes) and STRIPE_SECRET_KEY added to REQUIRED
// Authorized by HUB-4.1 L2 — Red Team M2/M5/L1: strengthen LEASE_ENCRYPTION_KEY validation to exact 64-char hex;
//   add STRIPE_WEBHOOK_SIGNING_SECRET and HOOK_ENCRYPTION_KEY to REQUIRED so missing values fail at startup
// Authorized by HUB-1592 (E-BE-1 S9, CR-1) — Atlassian Cloud REST v3 Basic auth pair:
//   JIRA_SERVICE_TOKEN + JIRA_SERVICE_EMAIL. Both required per D-HUB-SCOPE-029.
// Authorized by HUB-1593 (E-BE-1 S10, CR-1) — JIRA_WORKSPACE_URL: Atlassian Cloud workspace
//   base URL (e.g., https://fairwindssoftware.atlassian.net). jiraIntegrationService prefixes
//   every REST v3 path with this. Required at startup.
import logger from '../lib/logger.js';

const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'OPERATOR_JWT_SECRET',
  'LEASE_ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SIGNING_SECRET',
  'HOOK_ENCRYPTION_KEY',
  'JIRA_SERVICE_TOKEN',
  'JIRA_SERVICE_EMAIL',
  'JIRA_WORKSPACE_URL',
] as const;

const LEASE_KEY_HEX_RE = /^[0-9a-f]{64}$/i;

export function validateEnv(): void {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.error({ missingVars: missing }, 'Missing required environment variables — startup aborted');
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const leaseKey = process.env['LEASE_ENCRYPTION_KEY']!;
  if (!LEASE_KEY_HEX_RE.test(leaseKey)) {
    throw new Error(
      'HUB startup failed: LEASE_ENCRYPTION_KEY must be exactly 64 hex characters (32-byte AES-256 key)',
    );
  }
}
