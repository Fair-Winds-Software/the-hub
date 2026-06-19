// Authorized by HUB-525 — global test setup: LEASE_ENCRYPTION_KEY for leaseCrypto module-load validation
// Authorized by HUB-1525 — STRIPE_SECRET_KEY added to required vars; fallback ensures non-server tests don't break
// leaseCrypto.ts validates this env var at module load time. Setting it here ensures every test
// worker has it before any imports are resolved, preventing failures in unrelated test files.
process.env.LEASE_ENCRYPTION_KEY = process.env.LEASE_ENCRYPTION_KEY ?? '00'.repeat(32);
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_vitest_global_fallback';
