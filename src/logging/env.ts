// Authorized by HUB-237 — startup observability env validation; warn + apply default; never throws
// Authorized by HUB-1526 (FVL-E35) — invalid LOG_LEVEL now calls process.exit(1) per FR-35-05 epic AC
// Call validateObservabilityEnv() from every process entry point before createLogger().

const VALID_PINO_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const VALID_STRIPE_FLAGS = ['true', 'false'] as const;

// Validates LOG_LEVEL and HEALTH_CHECK_STRIPE_ENABLED at process startup.
// Invalid LOG_LEVEL aborts startup via process.exit(1) — a misconfigured log
// level can mask critical errors in production.
// Invalid HEALTH_CHECK_STRIPE_ENABLED warns and defaults (non-critical config).
// Safe to call multiple times with valid config.
export function validateObservabilityEnv(): void {
  const logLevel = process.env.LOG_LEVEL;
  if (logLevel !== undefined && !(VALID_PINO_LEVELS as readonly string[]).includes(logLevel)) {
    console.error(
      `[hub] Invalid LOG_LEVEL="${logLevel}" — must be one of ${VALID_PINO_LEVELS.join(', ')}; aborting startup`,
    );
    process.exit(1);
  }

  const stripeEnabled = process.env.HEALTH_CHECK_STRIPE_ENABLED;
  if (stripeEnabled !== undefined && !(VALID_STRIPE_FLAGS as readonly string[]).includes(stripeEnabled)) {
    console.warn(
      `[hub] Invalid HEALTH_CHECK_STRIPE_ENABLED="${stripeEnabled}" — must be "true", "false", or absent; defaulting to enabled`,
    );
    delete process.env.HEALTH_CHECK_STRIPE_ENABLED;
  }
}
