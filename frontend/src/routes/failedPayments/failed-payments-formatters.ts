// Authorized by HUB-1687 (E-FE-13 S2) — shared formatters for the Failed
// Payment Tracker (list + drawer + CSV / bulk-email preview later).
// Multi-currency Intl formatter — v0.1 supports USD, EUR, GBP, CAD, AUD
// (matches Stripe's default supported currencies). Unknown currency
// codes render as `${amount} ${CODE}` fallback so the operator sees
// something even if a new currency lands.
//
// Same single-source-of-truth pattern as system-health-formatters,
// customer-health-formatters, pricing-scenario-formatters.

const SUPPORTED_CURRENCIES = new Set([
  'usd',
  'eur',
  'gbp',
  'cad',
  'aud',
  'nzd',
  'jpy',
]);

const currencyFormatterCache = new Map<string, Intl.NumberFormat>();

function getCurrencyFormatter(currency: string): Intl.NumberFormat | null {
  const code = currency.toLowerCase();
  if (!SUPPORTED_CURRENCIES.has(code)) return null;
  const cached = currencyFormatterCache.get(code);
  if (cached) return cached;
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code.toUpperCase(),
  });
  currencyFormatterCache.set(code, fmt);
  return fmt;
}

export function formatMultiCurrencyCents(
  cents: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (cents == null) return '—';
  const code = (currency ?? 'usd').toLowerCase();
  const fmt = getCurrencyFormatter(code);
  const amount = code === 'jpy' ? cents : cents / 100;
  if (fmt) return fmt.format(amount);
  return `${amount.toFixed(2)} ${code.toUpperCase()}`;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const DATETIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en-US', {
  numeric: 'auto',
});

export function formatDate(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return DATE_FORMATTER.format(d);
}

export function formatDateTime(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return DATETIME_FORMATTER.format(d);
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const target = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = target - now;
  const absMs = Math.abs(diffMs);
  const day = 24 * 60 * 60 * 1000;
  if (absMs > 7 * day) return formatDateTime(iso);
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  if (absMs < minute) return 'just now';
  if (absMs < hour) return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / minute), 'minute');
  if (absMs < day) return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / hour), 'hour');
  return RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / day), 'day');
}

/** Human-readable label for a hub_state — used in badges + selection UX. */
export function statusLabel(
  status: 'pending_retry' | 'exhausted' | 'recovered' | 'overridden',
): string {
  switch (status) {
    case 'pending_retry':
      return 'Pending retry';
    case 'exhausted':
      return 'Exhausted';
    case 'recovered':
      return 'Recovered';
    case 'overridden':
      return 'Overridden';
  }
}
