// Authorized by HUB-216 — unit tests for createLogger() factory and resolveLogLevel()
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveLogLevel, createLogger } from '../index.js';

// ── resolveLogLevel() ─────────────────────────────────────────────────────────

describe('resolveLogLevel()', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let savedLogLevel: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    savedLogLevel = process.env.LOG_LEVEL;
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedLogLevel !== undefined) {
      process.env.LOG_LEVEL = savedLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
    if (savedNodeEnv !== undefined) {
      process.env.NODE_ENV = savedNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it('returns the LOG_LEVEL value when it is a valid Pino level', () => {
    process.env.LOG_LEVEL = 'warn';
    expect(resolveLogLevel()).toBe('warn');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns "info" and emits console.warn when LOG_LEVEL is invalid', () => {
    process.env.LOG_LEVEL = 'verbose';
    expect(resolveLogLevel()).toBe('info');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0] as string).toContain('verbose');
  });

  it('returns "info" when NODE_ENV=production and LOG_LEVEL is absent', () => {
    process.env.NODE_ENV = 'production';
    expect(resolveLogLevel()).toBe('info');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns "debug" when NODE_ENV is development and LOG_LEVEL is absent', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveLogLevel()).toBe('debug');
  });

  it('returns "debug" when NODE_ENV is absent and LOG_LEVEL is absent', () => {
    expect(resolveLogLevel()).toBe('debug');
  });

  it('accepts all valid Pino levels without warning', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      process.env.LOG_LEVEL = level;
      expect(resolveLogLevel()).toBe(level);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── createLogger() ────────────────────────────────────────────────────────────

describe('createLogger()', () => {
  let savedLogLevel: string | undefined;

  beforeEach(() => {
    savedLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'trace'; // emit all levels in tests
  });

  afterEach(() => {
    if (savedLogLevel !== undefined) {
      process.env.LOG_LEVEL = savedLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  it('returns a logger with all 4 schema fields bound to null by default', () => {
    const logger = createLogger();
    expect(logger.bindings()).toMatchObject({
      trace_id: null,
      span_id: null,
      tenant_id: null,
      product_id: null,
    });
  });

  it('overrides individual bindings when provided', () => {
    const logger = createLogger({ tenant_id: 'tenant-abc', product_id: 'prod-xyz' });
    expect(logger.bindings()).toMatchObject({
      trace_id: null,
      span_id: null,
      tenant_id: 'tenant-abc',
      product_id: 'prod-xyz',
    });
  });

  it('sets the logger level from LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = createLogger();
    expect(logger.level).toBe('warn');
  });

  it('all 4 schema fields are present in the bindings object (never absent)', () => {
    const logger = createLogger();
    const bindings = logger.bindings();
    expect(Object.keys(bindings)).toEqual(
      expect.arrayContaining(['trace_id', 'span_id', 'tenant_id', 'product_id']),
    );
  });
});
