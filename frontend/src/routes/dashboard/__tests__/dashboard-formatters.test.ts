// Authorized by HUB-1650 (E-FE-2 S7) — dashboard-formatters tests. Locks
// the FR-011 relative/absolute time split and the FR-012 currency contract
// so downstream widgets can consume the module with confidence.
import { describe, expect, it } from 'vitest';
import {
  formatAbsoluteDate,
  formatDollarsFromCents,
  formatRelativeTime,
} from '../dashboard-formatters';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe('dashboard-formatters (HUB-1650)', () => {
  describe('formatDollarsFromCents (FR-012)', () => {
    it('renders cents as dollar-denominated USD without fractional digits', () => {
      expect(formatDollarsFromCents(0)).toBe('$0');
      expect(formatDollarsFromCents(50_00)).toBe('$50');
      expect(formatDollarsFromCents(1_000_00)).toBe('$1,000');
    });
  });

  describe('formatRelativeTime (FR-011)', () => {
    it('renders "just now" when the timestamp is inside the last minute', () => {
      expect(formatRelativeTime(isoAgo(30_000))).toBe('just now');
    });

    it('renders "N min ago" between 1 minute and 1 hour', () => {
      expect(formatRelativeTime(isoAgo(4 * MIN))).toBe('4 min ago');
      expect(formatRelativeTime(isoAgo(59 * MIN))).toBe('59 min ago');
    });

    it('renders "N h ago" between 1 hour and 1 day', () => {
      expect(formatRelativeTime(isoAgo(2 * HOUR))).toBe('2 h ago');
      expect(formatRelativeTime(isoAgo(23 * HOUR))).toBe('23 h ago');
    });

    it('renders "N d ago" between 1 day and 7 days', () => {
      expect(formatRelativeTime(isoAgo(3 * DAY))).toBe('3 d ago');
    });

    it('falls back to absolute date beyond 7 days', () => {
      // 8-day-old timestamp — should surface an Intl-formatted date.
      const rel = formatRelativeTime(isoAgo(8 * DAY));
      // Assertion is Intl-tolerant: expect either "Jun N, 2026" or the
      // month abbreviation of the older date; the string just cannot be a
      // relative token.
      expect(rel).not.toMatch(/ago$/);
      expect(rel).toMatch(/\d{4}/);
    });

    it('returns "unknown" for an unparseable ISO string', () => {
      expect(formatRelativeTime('not-a-date')).toBe('unknown');
    });
  });

  describe('formatAbsoluteDate', () => {
    it('renders a stable "Mon DD, YYYY" string via Intl', () => {
      const s = formatAbsoluteDate('2026-06-15T00:00:00.000Z');
      expect(s).toMatch(/\d{4}/);
      expect(s).toMatch(/Jun|Jul/); // TZ jitter across ISO parse.
    });
  });
});
