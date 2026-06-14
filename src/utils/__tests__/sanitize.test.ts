// Authorized by HUB-147 — unit tests for sanitizePayload PII scrubber
import { describe, it, expect } from 'vitest';
import { sanitizePayload } from '../sanitize.js';

describe('sanitizePayload()', () => {
  it('replaces top-level PII keys with [redacted]', () => {
    const result = sanitizePayload({ tenantId: 'abc', email: 'user@example.com', amount: 5 });
    expect(result).toEqual({ tenantId: '[redacted]', email: '[redacted]', amount: 5 });
  });

  it('redacts all PII key variants', () => {
    const input = { secret: 'x', token: 'y', password: 'z', apiKey: 'k', client_secret: 'cs', jwt: 'j' };
    const result = sanitizePayload(input) as Record<string, unknown>;
    expect(result.secret).toBe('[redacted]');
    expect(result.token).toBe('[redacted]');
    expect(result.password).toBe('[redacted]');
    expect(result.apiKey).toBe('[redacted]');
    expect(result.client_secret).toBe('[redacted]');
    expect(result.jwt).toBe('[redacted]');
  });

  it('recursively redacts nested PII keys', () => {
    const result = sanitizePayload({ user: { email: 'foo@bar.com', name: 'Alice' } });
    expect(result).toEqual({ user: { email: '[redacted]', name: 'Alice' } });
  });

  it('recursively redacts deeply nested PII', () => {
    const result = sanitizePayload({ data: { inner: { secret: 'shh' } } });
    expect(result).toEqual({ data: { inner: { secret: '[redacted]' } } });
  });

  it('leaves non-PII keys untouched', () => {
    const result = sanitizePayload({ productId: 'p1', amount: 99, currency: 'USD' });
    expect(result).toEqual({ productId: 'p1', amount: 99, currency: 'USD' });
  });

  it('handles null and primitive values', () => {
    expect(sanitizePayload(null)).toBeNull();
    expect(sanitizePayload(42)).toBe(42);
    expect(sanitizePayload('hello')).toBe('hello');
  });

  it('handles arrays by sanitizing each element', () => {
    const result = sanitizePayload([{ email: 'a@b.com', id: 1 }, { id: 2 }]);
    expect(result).toEqual([{ email: '[redacted]', id: 1 }, { id: 2 }]);
  });
});
