// Authorized by HUB-1659 (E-FE-5 S9) — Cross-cutting formatters for the
// Pricing & Billing Config Epic. S4/S5/S6/S7/S8 import from here so all
// currency + date values render consistently and the FR-021 invariant
// ("raw cents never visible in any UI string") holds across the surface.
//
// Pure functions; no React state; safe to call from any render path.

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const ABSOLUTE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const MINUTES_PER_HOUR = 60;
const MILLIS_PER_MINUTE = 60_000;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
const RELATIVE_WINDOW_MINUTES = 7 * MINUTES_PER_DAY;

/** FR-021 — dollar-denominated currency from a cents integer. */
export function formatCurrency(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return CURRENCY_FORMATTER.format(cents / 100);
}

/** FR-021 — parse operator input (a string of dollars OR cents) into cents.
 * When the input string contains a decimal point, it's treated as dollars
 * ("19.99" -> 1999); otherwise the raw integer is treated as cents
 * ("1999" -> 1999). Returns null on unparseable input.
 */
export function parseCentsInput(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('.')) {
    const dollars = parseFloat(trimmed);
    if (Number.isNaN(dollars)) return null;
    return Math.round(dollars * 100);
  }
  const cents = parseInt(trimmed, 10);
  if (Number.isNaN(cents)) return null;
  return cents;
}

/** FR-023 — relative-time for ≤7 days, absolute date beyond. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - t) / MILLIS_PER_MINUTE));
  if (mins < 1) return 'just now';
  if (mins < MINUTES_PER_HOUR) return `${mins} min ago`;
  if (mins < MINUTES_PER_DAY) {
    const hrs = Math.floor(mins / MINUTES_PER_HOUR);
    return `${hrs} h ago`;
  }
  if (mins < RELATIVE_WINDOW_MINUTES) {
    const days = Math.floor(mins / MINUTES_PER_DAY);
    return `${days} d ago`;
  }
  return ABSOLUTE_DATE_FORMATTER.format(new Date(t));
}

/** Absolute-only formatter for expiry dates that shouldn't decay to
 * relative ("expired 3 d ago" is worse than "Jan 15, 2025" for archival
 * lookups). Used by the exceptions surface for expiry_date. */
export function formatDateAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return ABSOLUTE_DATE_FORMATTER.format(d);
}
