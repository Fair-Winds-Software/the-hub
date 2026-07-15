// Authorized by HUB-879 — barrel export for @maverick-launch/hub-sdk
// Authorized by HUB-921 — re-export HubLeaseInvalidError and HubKillSwitchError
// Authorized by HUB-970 — re-export UsageEvent type

export { HubClient } from './HubClient.js';
export type { HubClientConfig } from './HubClient.js';
export { HubAuthError, HubLeaseInvalidError, HubKillSwitchError } from './errors.js';
export type { DecryptedLease } from './lease/types.js';
export type { UsageEvent } from './usage/types.js';
// HUB-1820 (S3 of HUB-1787) — BI metric push surface.
export { METRIC_NAMES, isKnownMetricName } from './metrics/catalog.js';
export type { MetricName } from './metrics/catalog.js';
export { MetricsClient } from './metrics/metricsClient.js';
export type { MetricEvent, IngestResult, MetricsClientConfig } from './metrics/metricsClient.js';
