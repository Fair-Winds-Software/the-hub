// Authorized by HUB-1545 (System Health spec-deviation close-out) —
// exercises deriveSeverity + verifies writeAuditEntry writes the severity
// column derived from event_type (or an explicit override).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPoolQuery = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [] }));
vi.mock('../../db/pool.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

import { deriveSeverity, writeAuditEntry } from '../auditLogService.js';

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('deriveSeverity', () => {
  it('returns explicit override when provided', () => {
    expect(deriveSeverity('auth.login.success', 'error')).toBe('error');
  });
  it('defaults to error when event_type ends in .failure', () => {
    expect(deriveSeverity('auth.login.failure', null)).toBe('error');
  });
  it('defaults to info otherwise', () => {
    expect(deriveSeverity('auth.login.success', null)).toBe('info');
    expect(deriveSeverity(null, null)).toBe('info');
    expect(deriveSeverity(undefined, undefined)).toBe('info');
  });
});

describe('writeAuditEntry — severity column', () => {
  it('writes severity=error automatically for .failure event_types', async () => {
    await writeAuditEntry({
      tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      operation: 'INSERT',
      table_name: 'sessions',
      event_type: 'auth.login.failure',
    });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
    // Position 15 (0-indexed 14) is severity per the INSERT column order.
    expect(params[14]).toBe('error');
  });

  it('writes severity=info for success events', async () => {
    await writeAuditEntry({
      tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      operation: 'INSERT',
      table_name: 'sessions',
      event_type: 'auth.login.success',
    });
    const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
    expect(params[14]).toBe('info');
  });

  it('honors an explicit severity override', async () => {
    await writeAuditEntry({
      tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      operation: 'UPDATE',
      table_name: 'products',
      severity: 'warn',
    });
    const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
    expect(params[14]).toBe('warn');
  });
});
