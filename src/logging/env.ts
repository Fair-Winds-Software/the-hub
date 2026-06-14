// Authorized by HUB-237 — startup observability env validation; warn + apply default; never throws
// Call validateObservabilityEnv() from every process entry point before createLogger().

const VALID_PINO_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const VALID_STRIPE_FLAGS = ['true', 'false'] as const;

// Validates LOG_LEVEL and HEALTH_CHECK_STRIPE_ENABLED at process startup.
// Emits console.warn for invalid values and corrects the env var so that
// downstream calls to resolveLogLevel() and health probes see a valid value.
// Safe to call multiple times; never throws.
export function validateObservabilityEnv(): void {
  const logLevel = process.env.LOG_LEVEL;
  if (logLevel !== undefined && !(VALID_PINO_LEVELS as readonly string[]).includes(logLevel)) {
    const defaultLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
    console.warn(
      `[hub] Invalid LOG_LEVEL="${logLevel}" — must be one of ${VALID_PINO_LEVELS.join(', ')}; defaulting to "${defaultLevel}"`,
    );
    process.env.LOG_LEVEL = defaultLevel;
  }

  const stripeEnabled = process.env.HEALTH_CHECK_STRIPE_ENABLED;
  if (stripeEnabled !== undefined && !(VALID_STRIPE_FLAGS as readonly string[]).includes(stripeEnabled)) {
    console.warn(
      `[hub] Invalid HEALTH_CHECK_STRIPE_ENABLED="${stripeEnabled}" — must be "true", "false", or absent; defaulting to enabled`,
    );
    delete process.env.HEALTH_CHECK_STRIPE_ENABLED;
  }
}
