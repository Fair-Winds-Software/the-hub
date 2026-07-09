// Authorized by HUB-525 — global test setup: LEASE_ENCRYPTION_KEY for leaseCrypto module-load validation
// Authorized by HUB-1525 — STRIPE_SECRET_KEY added to required vars; fallback ensures non-server tests don't break
// Authorized by HUB-4.1 L2 — Red Team M5/L1: STRIPE_WEBHOOK_SIGNING_SECRET + HOOK_ENCRYPTION_KEY fallbacks
// Authorized by HUB-1770 — JIRA_SERVICE_TOKEN + JIRA_SERVICE_EMAIL + JIRA_WORKSPACE_URL fallbacks. These
// were added to config/env.ts REQUIRED by HUB-1592 + HUB-1593 (E-BE-1 S9/S10) but never mirrored here,
// causing every test that calls buildApp() to fail validateEnv() locally. Fallbacks let those tests
// initialize without live Atlassian credentials; tests that actually exercise the Jira integration
// path (e.g., jiraIntegrationService.integration.test.ts) still need real values in the environment.
// leaseCrypto.ts validates LEASE_ENCRYPTION_KEY at module load time. All fallbacks here ensure every test
// worker has required vars before any imports resolve, preventing failures in unrelated test files.
process.env.LEASE_ENCRYPTION_KEY = process.env.LEASE_ENCRYPTION_KEY ?? '00'.repeat(32);
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_vitest_global_fallback';
process.env.STRIPE_WEBHOOK_SIGNING_SECRET = process.env.STRIPE_WEBHOOK_SIGNING_SECRET ?? 'whsec_vitest_global_fallback';
process.env.HOOK_ENCRYPTION_KEY = process.env.HOOK_ENCRYPTION_KEY ?? '00'.repeat(32);
process.env.JIRA_SERVICE_TOKEN = process.env.JIRA_SERVICE_TOKEN ?? 'test-jira-service-token-vitest';
process.env.JIRA_SERVICE_EMAIL = process.env.JIRA_SERVICE_EMAIL ?? 'test-jira-service@vitest.local';
process.env.JIRA_WORKSPACE_URL = process.env.JIRA_WORKSPACE_URL ?? 'https://vitest.atlassian.net';
// Authorized by HUB-1770 — JWT_SECRET + OPERATOR_JWT_SECRET fallbacks. Same story as JIRA_*: added to
// REQUIRED long ago, only set per-file-beforeAll in some test files, causing tests that call buildApp()
// without an explicit beforeAll to fail validateEnv() locally.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-vitest-fallback';
process.env.OPERATOR_JWT_SECRET = process.env.OPERATOR_JWT_SECRET ?? 'test-operator-jwt-secret-vitest-fallback';
// Authorized by HUB-1771 Phase 4 — PORTAL_JWT_SECRET is not in config/env.ts REQUIRED
// (used only by portal/auth.ts) but the route throws 500 without it. Fallback here.
process.env.PORTAL_JWT_SECRET = process.env.PORTAL_JWT_SECRET ?? 'test-portal-jwt-secret-vitest-fallback';
