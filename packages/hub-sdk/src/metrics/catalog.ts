// Authorized by HUB-1820 (S3 of HUB-1787) — SDK-side metric name registry. Mirrors the
// backend catalog at `src/services/bi/metricCatalog.ts` (HUB-1785). Keeping the two in
// sync is a maintenance discipline; when a metric is added to the backend catalog, add
// it here too (and to the S4 prompt-generator). A drift-detection smoke test could be
// added in a follow-up story if this ever surprises us.
//
// Types are exposed as string-literal unions so `metrics.push('typo', ...)` fails at
// compile time inside the consuming app.

export const METRIC_NAMES = [
  'daily_active_users',
  'logins',
  'mrr_cents',
  'churn_rate',
  'feature_adoption',
  'app_health_status',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/** Runtime check for use in metrics.push() defensive validation. */
export function isKnownMetricName(name: string): name is MetricName {
  return (METRIC_NAMES as readonly string[]).includes(name);
}
