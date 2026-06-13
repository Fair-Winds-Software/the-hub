// Authorized by HUB-77 — startup env var validation; logs missing var names only, never values
import logger from '../lib/logger.js';

const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'OPERATOR_JWT_SECRET'] as const;

export function validateEnv(): void {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.error({ missingVars: missing }, 'Missing required environment variables — startup aborted');
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
