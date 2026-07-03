// Authorized by HUB-1685 (E-FE-9 S6) — cross-cutting formatters shared by
// the customer-health list (S2), filter sidebar + CSV export (S3), drill-
// in chart (S4), and signals panel (S5). Single-source-of-truth pattern
// mirrors HUB-1679's system-health-formatters.ts — if these drift across
// consumers, operators see the table and the CSV showing different
// numbers.

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const DATE_SHORT_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en-US', {
  numeric: 'auto',
});

export function formatCurrency(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return CURRENCY_FORMATTER.format(cents / 100);
}

export function formatScore(score: number): string {
  return score.toFixed(2);
}

export function formatDate(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return DATE_FORMATTER.format(d);
}

export function formatDateShort(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return DATE_SHORT_FORMATTER.format(d);
}

/**
 * Renders "5 days ago" / "just now" / absolute date beyond 7 days. Reads
 * clearly in the list + drill-in without operators having to hover a
 * tooltip to convert a raw ISO string.
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const target = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = target - now;
  const absMs = Math.abs(diffMs);
  const day = 24 * 60 * 60 * 1000;
  if (absMs > 7 * day) return formatDate(iso);
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  if (absMs < minute) return 'just now';
  if (absMs < hour) return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / minute), 'minute');
  if (absMs < day) return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / hour), 'hour');
  return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / day), 'day');
}

/**
 * Risk-level string used in filter + CSV. Maps a health badge to the
 * human-readable "High" / "Medium" / "Low" — one place so the CSV export
 * matches the filter sidebar checkbox labels.
 */
export function badgeToRiskLevel(badge: 'red' | 'yellow' | 'green'): 'High' | 'Medium' | 'Low' {
  if (badge === 'red') return 'High';
  if (badge === 'yellow') return 'Medium';
  return 'Low';
}
