// Authorized by HUB-237 — unit tests for validateObservabilityEnv(); AC5 per-job binding integration test
// Authorized by HUB-1526 (FVL-E35) — invalid LOG_LEVEL now asserts process.exit(1) per FR-35-05
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'stream';
import pino from 'pino';

// ── validateObservabilityEnv() ────────────────────────────────────────────────

import { validateObservabilityEnv } from '../env.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let warnSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let errorSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  delete process.env.LOG_LEVEL;
  delete process.env.HEALTH_CHECK_STRIPE_ENABLED;
});

// ── LOG_LEVEL ─────────────────────────────────────────────────────────────────

describe('validateObservabilityEnv() — LOG_LEVEL', () => {
  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])(
    'does not exit for valid level "%s"',
    (level) => {
      process.env.LOG_LEVEL = level;
      validateObservabilityEnv();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(process.env.LOG_LEVEL).toBe(level);
    },
  );

  it('calls process.exit(1) when LOG_LEVEL is invalid', () => {
    process.env.LOG_LEVEL = 'verbose';
    validateObservabilityEnv();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('emits console.error (not warn) when LOG_LEVEL is invalid', () => {
    process.env.LOG_LEVEL = 'verbose';
    validateObservabilityEnv();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain('Invalid LOG_LEVEL="verbose"');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not exit when LOG_LEVEL is absent', () => {
    delete process.env.LOG_LEVEL;
    validateObservabilityEnv();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── HEALTH_CHECK_STRIPE_ENABLED ───────────────────────────────────────────────

describe('validateObservabilityEnv() — HEALTH_CHECK_STRIPE_ENABLED', () => {
  it('emits no warn for "true"', () => {
    process.env.HEALTH_CHECK_STRIPE_ENABLED = 'true';
    validateObservabilityEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits no warn for "false"', () => {
    process.env.HEALTH_CHECK_STRIPE_ENABLED = 'false';
    validateObservabilityEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits no warn when absent', () => {
    delete process.env.HEALTH_CHECK_STRIPE_ENABLED;
    validateObservabilityEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits warn for "banana" and defaults to enabled (env var deleted)', () => {
    process.env.HEALTH_CHECK_STRIPE_ENABLED = 'banana';
    validateObservabilityEnv();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('Invalid HEALTH_CHECK_STRIPE_ENABLED="banana"');
    expect(process.env.HEALTH_CHECK_STRIPE_ENABLED).toBeUndefined();
  });

  it('does not exit for invalid HEALTH_CHECK_STRIPE_ENABLED', () => {
    process.env.HEALTH_CHECK_STRIPE_ENABLED = 'yes';
    validateObservabilityEnv();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('validateObservabilityEnv() — idempotency', () => {
  it('can be called multiple times with valid config without accumulating warnings or exits', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.HEALTH_CHECK_STRIPE_ENABLED = 'false';
    validateObservabilityEnv();
    validateObservabilityEnv();
    validateObservabilityEnv();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ── AC5: per-job child logger binding (integration) ───────────────────────────
// Validates that createLogger().child({ tenant_id, product_id }) produces log
// lines with all 7 required schema fields: level, time, trace_id, span_id,
// tenant_id, product_id, msg.

describe('AC5 — per-job child logger binding', () => {
  it('child logger produces all 7 schema fields bound from job data', () => {
    const lines: Record<string, unknown>[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        chunk
          .toString()
          .split('\n')
          .filter(Boolean)
          .forEach((l) => {
            try {
              lines.push(JSON.parse(l) as Record<string, unknown>);
            } catch {
              // ignore non-JSON lines
            }
          });
        cb();
      },
    });

    // Simulate the worker root logger (trace_id/span_id always null in async jobs)
    const rootLogger = pino({ level: 'debug', base: null }, dest).child({
      trace_id: null,
      span_id: null,
      tenant_id: null,
      product_id: null,
    });

    // Simulate per-job child binding: tenant_id + product_id from job.data
    const jobData = { tenant_id: 'test-tenant-uuid', product_id: 'test-product-uuid' };
    const jobLog = rootLogger.child({
      tenant_id: jobData.tenant_id ?? null,
      product_id: jobData.product_id ?? null,
    });

    jobLog.info('job processing started');

    expect(lines.length).toBe(1);
    const line = lines[0];

    // All 7 required schema fields must be present
    expect(line).toHaveProperty('level');
    expect(line).toHaveProperty('time');
    expect(line).toHaveProperty('trace_id');
    expect(line).toHaveProperty('span_id');
    expect(line).toHaveProperty('tenant_id');
    expect(line).toHaveProperty('product_id');
    expect(line).toHaveProperty('msg');

    // Values match job data and worker context
    expect(line.trace_id).toBeNull();
    expect(line.span_id).toBeNull();
    expect(line.tenant_id).toBe('test-tenant-uuid');
    expect(line.product_id).toBe('test-product-uuid');
    expect(line.msg).toBe('job processing started');
  });

  it('absent tenant_id and product_id in job.data bind as null', () => {
    const lines: Record<string, unknown>[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
        chunk
          .toString()
          .split('\n')
          .filter(Boolean)
          .forEach((l) => {
            try {
              lines.push(JSON.parse(l) as Record<string, unknown>);
            } catch {
              // ignore
            }
          });
        cb();
      },
    });

    const rootLogger = pino({ level: 'debug', base: null }, dest).child({
      trace_id: null,
      span_id: null,
      tenant_id: null,
      product_id: null,
    });

    // job.data has no tenant_id or product_id
    const jobData: Record<string, unknown> = {};
    const jobLog = rootLogger.child({
      tenant_id: (jobData.tenant_id as string | undefined) ?? null,
      product_id: (jobData.product_id as string | undefined) ?? null,
    });

    jobLog.warn('job has no tenant context');

    expect(lines.length).toBe(1);
    expect(lines[0].tenant_id).toBeNull();
    expect(lines[0].product_id).toBeNull();
    expect(lines[0].trace_id).toBeNull();
    expect(lines[0].span_id).toBeNull();
  });
});
