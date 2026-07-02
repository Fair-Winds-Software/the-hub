// Authorized by HUB-1659 (E-FE-5 S9) — pricing-formatters tests. Locks the
// FR-021 (currency) + FR-023 (relative/absolute date split) invariants so
// the S4/S5/S6/S7 refactor to the shared helper never regresses.
import { describe, expect, it } from 'vitest';
import {
  formatCurrency,
  formatDate,
  formatDateAbsolute,
  parseCentsInput,
} from '../pricing-formatters';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe('pricing-formatters (HUB-1659)', () => {
  describe('formatCurrency (FR-021)', () => {
    it('renders cents as dollar-denominated USD', () => {
      expect(formatCurrency(0)).toBe('$0.00');
      expect(formatCurrency(9900)).toBe('$99.00');
      expect(formatCurrency(1_234_56)).toBe('$1,234.56');
    });

    it('renders null / undefined as an em-dash', () => {
      expect(formatCurrency(null)).toBe('—');
      expect(formatCurrency(undefined)).toBe('—');
    });
  });

  describe('parseCentsInput (FR-021 inverse)', () => {
    it('parses a raw integer as cents', () => {
      expect(parseCentsInput('1999')).toBe(1999);
    });
    it('parses a decimal as dollars → cents', () => {
      expect(parseCentsInput('19.99')).toBe(1999);
      expect(parseCentsInput('19.995')).toBe(2000);
    });
    it('returns null on unparseable input', () => {
      expect(parseCentsInput('')).toBeNull();
      expect(parseCentsInput('abc')).toBeNull();
    });
  });

  describe('formatDate (FR-023)', () => {
    it('renders "just now" under a minute', () => {
      expect(formatDate(isoAgo(20_000))).toBe('just now');
    });
    it('renders "N min ago" under an hour', () => {
      expect(formatDate(isoAgo(5 * MIN))).toBe('5 min ago');
    });
    it('renders "N h ago" under a day', () => {
      expect(formatDate(isoAgo(3 * HOUR))).toBe('3 h ago');
    });
    it('renders "N d ago" under a week', () => {
      expect(formatDate(isoAgo(4 * DAY))).toBe('4 d ago');
    });
    it('falls back to absolute beyond 7 days', () => {
      const older = formatDate(isoAgo(20 * DAY));
      expect(older).not.toMatch(/ago$/);
      expect(older).toMatch(/\d{4}/);
    });
    it('returns em-dash on null / unparseable', () => {
      expect(formatDate(null)).toBe('—');
      expect(formatDate('not-a-date')).toBe('—');
    });
  });

  describe('formatDateAbsolute', () => {
    it('renders the Intl absolute date', () => {
      expect(formatDateAbsolute('2026-06-15T00:00:00.000Z')).toMatch(/\d{4}/);
    });
    it('returns em-dash on null / unparseable', () => {
      expect(formatDateAbsolute(null)).toBe('—');
      expect(formatDateAbsolute('bogus')).toBe('—');
    });
  });
});
