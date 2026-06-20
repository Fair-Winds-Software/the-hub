// Authorized by HUB-48 FVL M1 — unit tests for getRetainMonths(): default, invalid, and below-minimum branches

import { describe, it, expect, afterEach } from 'vitest';

const ORIG = process.env['RETAIN_MONTHS'];

afterEach(() => {
  if (ORIG === undefined) {
    delete process.env['RETAIN_MONTHS'];
  } else {
    process.env['RETAIN_MONTHS'] = ORIG;
  }
});

describe('getRetainMonths()', () => {
  it('returns 24 when RETAIN_MONTHS is not set', async () => {
    delete process.env['RETAIN_MONTHS'];
    const { getRetainMonths } = await import('../retentionJob.js');
    expect(getRetainMonths()).toBe(24);
  });

  it('returns the parsed value when RETAIN_MONTHS is a valid integer', async () => {
    process.env['RETAIN_MONTHS'] = '36';
    const { getRetainMonths } = await import('../retentionJob.js');
    expect(getRetainMonths()).toBe(36);
  });

  it('returns 24 when RETAIN_MONTHS is not a valid integer (NaN)', async () => {
    process.env['RETAIN_MONTHS'] = 'banana';
    const { getRetainMonths } = await import('../retentionJob.js');
    expect(getRetainMonths()).toBe(24);
  });

  it('returns 24 when RETAIN_MONTHS is zero', async () => {
    process.env['RETAIN_MONTHS'] = '0';
    const { getRetainMonths } = await import('../retentionJob.js');
    expect(getRetainMonths()).toBe(24);
  });

  it('returns 24 when RETAIN_MONTHS is negative', async () => {
    process.env['RETAIN_MONTHS'] = '-3';
    const { getRetainMonths } = await import('../retentionJob.js');
    expect(getRetainMonths()).toBe(24);
  });

  it('returns the parsed value (not the default) when RETAIN_MONTHS is below 6', async () => {
    // Below-6 emits a warning but does NOT fall back to default — it uses the provided value
    process.env['RETAIN_MONTHS'] = '3';
    const { getRetainMonths } = await import('../retentionJob.js');
    expect(getRetainMonths()).toBe(3);
  });
});
