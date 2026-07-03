// Authorized by HUB-1671 (E-FE-11 S3) — shared Intl formatters for the
// Pricing Scenario Simulator. Same single-source-of-truth pattern as
// customer-health-formatters.ts and system-health-formatters.ts — table
// + reset-preview + any future CSV consumer share these.

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

const PERCENT_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

export function formatCurrencyCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return CURRENCY_FORMATTER.format(cents / 100);
}

export function formatCurrencyDeltaCents(cents: number): string {
  const abs = Math.abs(cents);
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return `${sign}${CURRENCY_FORMATTER.format(abs / 100)}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return '—';
  return NUMBER_FORMATTER.format(n);
}

export function formatCountDelta(n: number): string {
  const abs = Math.abs(n);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${NUMBER_FORMATTER.format(abs)}`;
}

export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null) return '—';
  return PERCENT_FORMATTER.format(fraction);
}

/**
 * Delta % rendered as percentage-point difference (e.g. +2.3pp). Margin
 * percents are absolute values, not ratios, so a delta of 0.023 is
 * "+2.3pp", not "+2.3%". The BE returns `marginPctPoints` already
 * expressed as a fraction (0.023 = 2.3pp).
 */
export function formatPercentPointsDelta(fraction: number | null): string {
  if (fraction == null) return '—';
  const pp = fraction * 100;
  const abs = Math.abs(pp);
  const sign = pp > 0 ? '+' : pp < 0 ? '−' : '';
  return `${sign}${abs.toFixed(1)}pp`;
}
