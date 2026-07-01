// Authorized by HUB-1650 (E-FE-2 S7) — Cross-cutting formatter helpers for
// the Dashboard Epic. S2/S3/S5 import from here so all currency + time
// values render consistently and locale-correctly (FR-011 + FR-012).
//
// The formatters are pure functions; no React, no side effects — they can
// be called from any widget's render body without triggering re-renders.

const MINUTES_PER_HOUR = 60;
const MILLIS_PER_MINUTE = 60_000;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
const DAYS_PER_RELATIVE_WINDOW = 7;
const MINUTES_PER_RELATIVE_WINDOW =
  DAYS_PER_RELATIVE_WINDOW * MINUTES_PER_DAY;

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const ABSOLUTE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

/** FR-012 — dollar-denominated currency from a cents integer. */
export function formatDollarsFromCents(cents: number): string {
  return CURRENCY_FORMATTER.format(cents / 100);
}

/**
 * FR-011 — relative for ≤7 days, absolute for older.
 * Returns "just now" / "N min ago" / "N h ago" / "N d ago" for recent
 * timestamps, and "Jun 15, 2026" for older ones. Never throws — an
 * unparseable ISO string yields "unknown".
 */
export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const mins = Math.max(0, Math.floor((Date.now() - t) / MILLIS_PER_MINUTE));
  if (mins < 1) return 'just now';
  if (mins < MINUTES_PER_HOUR) return `${mins} min ago`;
  if (mins < MINUTES_PER_DAY) {
    const hrs = Math.floor(mins / MINUTES_PER_HOUR);
    return `${hrs} h ago`;
  }
  if (mins < MINUTES_PER_RELATIVE_WINDOW) {
    const days = Math.floor(mins / MINUTES_PER_DAY);
    return `${days} d ago`;
  }
  return formatAbsoluteDate(iso);
}

/** Absolute date "Jun 15, 2026" via Intl. */
export function formatAbsoluteDate(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'unknown';
  return ABSOLUTE_DATE_FORMATTER.format(t);
}

/** "3:04 PM" via Intl — used when a row already surfaces a same-day time. */
export function formatAbsoluteTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'unknown';
  return ABSOLUTE_TIME_FORMATTER.format(t);
}
