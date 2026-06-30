// Authorized by HUB-1634 (E-FE-10 S5) — pure-function tests for the client-side
// impact-compute fallback. Verifies the semver-aware comparison (with
// lexicographic degradation for unparseable inputs) + the "deprecated or
// older" filter contract.
import { describe, expect, it } from 'vitest';
import {
  computeImpactClientSide,
  isAtOrOlderThan,
} from '../computeImpactClientSide';
import type { ProductBreakdownRow } from '../ProductBreakdownTable';

function row(
  productId: string,
  currentVersion: string,
): ProductBreakdownRow {
  return {
    productId,
    productName: `name-${productId}`,
    currentVersion,
    lastReportedAt: '2026-06-01T00:00:00.000Z',
    daysBehindLatest: 0,
    status: 'behind',
  };
}

describe('isAtOrOlderThan (HUB-1634 pure helper)', () => {
  it.each([
    ['1.4.0', '1.5.0', true],
    ['1.5.0', '1.4.0', false],
    ['1.5.0', '1.5.0', true], // equal = "would break"
    ['1.4.9', '1.5.0', true],
    ['2.0.0', '1.9.9', false],
    ['1.4.0', '1.4.1', true],
  ])('candidate=%s vs deprecated=%s → %s', (a, b, expected) => {
    expect(isAtOrOlderThan(a, b)).toBe(expected);
  });

  it('falls back to lexicographic when either input is not semver', () => {
    // 'rc-3' has no semver shape; lex comparison applies.
    expect(isAtOrOlderThan('rc-3', 'rc-4')).toBe(true);
    expect(isAtOrOlderThan('rc-5', 'rc-4')).toBe(false);
  });

  it('semver-parseable side anchors comparison: pre-release loses to numeric', () => {
    // '1.5.0-rc.1' parses as 1.5.0 (the regex stops at the dash); both
    // counted as 1.5.0 → at-or-older returns true (equal).
    expect(isAtOrOlderThan('1.5.0-rc.1', '1.5.0')).toBe(true);
  });
});

describe('computeImpactClientSide (HUB-1634)', () => {
  const PRODUCTS = [
    row('p-1', '1.5.0'),
    row('p-2', '1.4.0'),
    row('p-3', '1.3.0'),
    row('p-4', '2.0.0'),
  ];

  it('filters rows at or older than the deprecated version', () => {
    const result = computeImpactClientSide(PRODUCTS, '1.4.0');
    expect(result.impactedCount).toBe(2);
    const ids = result.products.map((p) => p.productId);
    expect(ids).toEqual(expect.arrayContaining(['p-2', 'p-3']));
  });

  it('returns 0 impact when no product is at the deprecated version or older', () => {
    const result = computeImpactClientSide(PRODUCTS, '1.0.0');
    expect(result.impactedCount).toBe(0);
    expect(result.products).toEqual([]);
  });

  it('includes products on the exact deprecated version (equal → impacted)', () => {
    const result = computeImpactClientSide(PRODUCTS, '1.5.0');
    const ids = result.products.map((p) => p.productId);
    expect(ids).toContain('p-1');
  });

  it('maps to the spec output shape ({productId, productName, currentVersion})', () => {
    const result = computeImpactClientSide(PRODUCTS, '1.5.0');
    for (const p of result.products) {
      expect(p).toHaveProperty('productId');
      expect(p).toHaveProperty('productName');
      expect(p).toHaveProperty('currentVersion');
    }
  });
});
