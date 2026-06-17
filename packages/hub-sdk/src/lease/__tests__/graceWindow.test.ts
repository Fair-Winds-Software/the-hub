// Authorized by HUB-957 — unit test: isWithinGraceWindow stub always returns false (DEF-001 pending)

import { describe, it, expect } from 'vitest';
import { isWithinGraceWindow } from '../graceWindow.js';
import type { DecryptedLease } from '../types.js';

describe('isWithinGraceWindow', () => {
  it('always returns false (stub — DEF-001 not yet defined)', () => {
    const lease: DecryptedLease = {
      tenantId: 'tenant-1',
      productId: 'product-x',
      features: [],
      maxSeats: 5,
      expiresAt: Date.now() - 1000, // already expired
    };
    expect(isWithinGraceWindow(lease)).toBe(false);
  });

  it('returns false even for a lease that is far from expiry', () => {
    const lease: DecryptedLease = {
      tenantId: 'tenant-1',
      productId: 'product-x',
      features: [],
      maxSeats: 5,
      expiresAt: Date.now() + 9_999_999,
    };
    expect(isWithinGraceWindow(lease)).toBe(false);
  });
});
