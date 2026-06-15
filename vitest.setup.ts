// Authorized by HUB-525 — global test setup: LEASE_ENCRYPTION_KEY for leaseCrypto module-load validation
// leaseCrypto.ts validates this env var at module load time. Setting it here ensures every test
// worker has it before any imports are resolved, preventing failures in unrelated test files.
process.env.LEASE_ENCRYPTION_KEY = process.env.LEASE_ENCRYPTION_KEY ?? '00'.repeat(32);
