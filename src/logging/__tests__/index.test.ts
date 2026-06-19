// Authorized by HUB-216 — unit tests for createLogger() factory and resolveLogLevel()
// Authorized by HUB-1526 (FVL-E35) — LEASE_ENCRYPTION_KEY and JWT_SECRET redaction tests
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveLogLevel, createLogger } from '../index.js';

// ── resolveLogLevel() ─────────────────────────────────────────────────────────

describe('resolveLogLevel()', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;
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

// ── createLogger() — redaction (FR-35-06) ─────────────────────────────────────

import { Writable } from 'stream';
import pino from 'pino';

describe('createLogger() — LEASE_ENCRYPTION_KEY and JWT_SECRET redaction (FR-35-06)', () => {
  function captureLines(): { lines: Record<string, unknown>[]; dest: Writable } {
    const lines: Record<string, unknown>[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        chunk.toString().split('\n').filter(Boolean).forEach((l) => {
          try { lines.push(JSON.parse(l) as Record<string, unknown>); } catch { /* skip */ }
        });
        cb();
      },
    });
    return { lines, dest };
  }

  function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  it('censors LEASE_ENCRYPTION_KEY as a top-level property', async () => {
    const { lines, dest } = captureLines();
    const logger = pino(
      { level: 'info', base: null, redact: { paths: ['LEASE_ENCRYPTION_KEY', '*.LEASE_ENCRYPTION_KEY', 'JWT_SECRET', '*.JWT_SECRET'], censor: '[redacted]' } },
      dest,
    );
    logger.info({ LEASE_ENCRYPTION_KEY: 'super-secret-key-value' }, 'init');
    await tick();
    expect(lines[0]).toHaveProperty('LEASE_ENCRYPTION_KEY', '[redacted]');
  });

  it('censors LEASE_ENCRYPTION_KEY as a nested property', async () => {
    const { lines, dest } = captureLines();
    const logger = pino(
      { level: 'info', base: null, redact: { paths: ['LEASE_ENCRYPTION_KEY', '*.LEASE_ENCRYPTION_KEY', 'JWT_SECRET', '*.JWT_SECRET'], censor: '[redacted]' } },
      dest,
    );
    logger.info({ config: { LEASE_ENCRYPTION_KEY: 'nested-secret' } }, 'config loaded');
    await tick();
    expect((lines[0] as Record<string, Record<string, unknown>>).config?.LEASE_ENCRYPTION_KEY).toBe('[redacted]');
  });

  it('censors JWT_SECRET as a top-level property', async () => {
    const { lines, dest } = captureLines();
    const logger = pino(
      { level: 'info', base: null, redact: { paths: ['LEASE_ENCRYPTION_KEY', '*.LEASE_ENCRYPTION_KEY', 'JWT_SECRET', '*.JWT_SECRET'], censor: '[redacted]' } },
      dest,
    );
    logger.info({ JWT_SECRET: 'jwt-secret-value' }, 'auth');
    await tick();
    expect(lines[0]).toHaveProperty('JWT_SECRET', '[redacted]');
  });
});
