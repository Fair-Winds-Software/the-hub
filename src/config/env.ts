// Authorized by HUB-77 — startup env var validation; logs missing var names only, never values
// Authorized by HUB-1525 — LEASE_ENCRYPTION_KEY (≥32 bytes) and STRIPE_SECRET_KEY added to REQUIRED
import logger from '../lib/logger.js';

const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'OPERATOR_JWT_SECRET',
  'LEASE_ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
] as const;

const LEASE_KEY_MIN_BYTES = 32;

export function validateEnv(): void {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.error({ missingVars: missing }, 'Missing required environment variables — startup aborted');
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const leaseKey = process.env['LEASE_ENCRYPTION_KEY']!;
  if (Buffer.byteLength(leaseKey, 'utf8') < LEASE_KEY_MIN_BYTES) {
    throw new Error(
      `HUB startup failed: LEASE_ENCRYPTION_KEY is too short (min ${LEASE_KEY_MIN_BYTES} bytes)`,
    );
  }
}
