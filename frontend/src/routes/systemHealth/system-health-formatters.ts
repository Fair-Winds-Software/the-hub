// Authorized by HUB-1679 (E-FE-7 S6) — cross-cutting formatters for the
// System Health Epic. S2 (portfolio grid) + S4 (Liveness/Errors) + S5
// (Queues/Webhooks) import from this module so all currency-free numeric
// + duration + percentage rendering stays consistent across the surface.
//
// Timestamps re-export `formatDate` from the shared pricing-formatters
// module — there's no reason to duplicate the FR-023 relative/absolute
// split, and keeping the single implementation avoids the drift risk
// the S9 refactor patterns in HUB-1659 + HUB-1668 documented.

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');
const PERCENT_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

export { formatDate as formatTimestamp } from '../productDetail/pricing-formatters';

/** Integer count via Intl (thousands separator). */
export function formatCount(n: number): string {
  return NUMBER_FORMATTER.format(n);
}

/** Percent (0..1 decimal) via Intl. */
export function formatPercent(rate: number): string {
  return PERCENT_FORMATTER.format(rate);
}

/**
 * Humanized duration for BullMQ oldest-job age (or any second-count).
 * Renders '5s' / '5m' / '2h' / '3d'; null renders as em-dash so table
 * cells stay aligned when a queue is empty.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
