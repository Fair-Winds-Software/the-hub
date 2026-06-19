// Authorized by HUB-216 — createLogger() factory; structured log schema; LOG_LEVEL resolution
// Authorized by HUB-1526 (FVL-E35) — LEASE_ENCRYPTION_KEY and JWT_SECRET added to redact paths per FR-35-06
import pino from 'pino';

const VALID_PINO_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export interface LogBindings {
  trace_id: string | null;
  span_id: string | null;
  tenant_id: string | null;
  product_id: string | null;
}

// Returns the resolved Pino log level from the environment.
// Falls back to 'info' on invalid values (with console.warn); defaults to
// 'debug' in non-production when LOG_LEVEL is absent.
export function resolveLogLevel(): string {
  const envLevel = process.env.LOG_LEVEL;
  if (envLevel) {
    if ((VALID_PINO_LEVELS as readonly string[]).includes(envLevel)) {
      return envLevel;
    }
    console.warn(`[hub] Invalid LOG_LEVEL="${envLevel}" — falling back to "info"`);
    return 'info';
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

// Returns a configured Pino logger with all 4 schema fields bound (null by
// default). All log lines produced by the returned logger (and its children)
// will include trace_id, span_id, tenant_id, product_id — null when absent,
// never omitted.
export function createLogger(bindings?: Partial<LogBindings>): pino.Logger {
  const level = resolveLogLevel();
  const merged: LogBindings = {
    trace_id: null,
    span_id: null,
    tenant_id: null,
    product_id: null,
    ...bindings,
  };
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-client-secret"]',
        '*.password',
        '*.secret',
        '*.token',
        'LEASE_ENCRYPTION_KEY',
        '*.LEASE_ENCRYPTION_KEY',
        'JWT_SECRET',
        '*.JWT_SECRET',
      ],
      censor: '[redacted]',
    },
  }).child(merged);
}
