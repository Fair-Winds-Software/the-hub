// Authorized by HUB-525 — global test setup: LEASE_ENCRYPTION_KEY for leaseCrypto module-load validation
// Authorized by HUB-1525 — STRIPE_SECRET_KEY added to required vars; fallback ensures non-server tests don't break
// Authorized by HUB-4.1 L2 — Red Team M5/L1: STRIPE_WEBHOOK_SIGNING_SECRET + HOOK_ENCRYPTION_KEY fallbacks
// leaseCrypto.ts validates LEASE_ENCRYPTION_KEY at module load time. All fallbacks here ensure every test
// worker has required vars before any imports resolve, preventing failures in unrelated test files.
process.env.LEASE_ENCRYPTION_KEY = process.env.LEASE_ENCRYPTION_KEY ?? '00'.repeat(32);
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_vitest_global_fallback';
process.env.STRIPE_WEBHOOK_SIGNING_SECRET = process.env.STRIPE_WEBHOOK_SIGNING_SECRET ?? 'whsec_vitest_global_fallback';
process.env.HOOK_ENCRYPTION_KEY = process.env.HOOK_ENCRYPTION_KEY ?? '00'.repeat(32);
