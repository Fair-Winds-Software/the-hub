// Authorized by HUB-1585 (E-BE-1 S2) — typed SSoT for v0.1 settings catalog. Mirrors the
// JSONB scalar values seeded by `db/migrations/047_settings_seeds.sql`. Consumers (BE
// services + HUB-1664 HUB Settings editor) read this map to render forms, validate
// operator-tuned overrides, and assert types at runtime.
//
// Adding a new key: (1) add the seed row to migration 047 (or a new migration), (2) add
// the catalog entry here, (3) bump the integration test expectation.

export type SettingsValueType = 'number' | 'boolean' | 'string' | 'json';

/** Default value contract — primitive types or a JSON object/array. */
export type SettingsCatalogDefault = number | boolean | string | Record<string, unknown> | unknown[];

export interface SettingsCatalogEntry {
  /** Unique key used in `settings.key`. */
  key: string;
  /** Default value seeded by migration 047/052/etc. */
  default: SettingsCatalogDefault;
  /** Type contract; UI editors render the matching control. */
  type: SettingsValueType;
  /** Operator-facing description rendered as inline help in HUB-1664 Settings editor. */
  description: string;
  /** First consumer story (for traceability when an operator asks why a setting exists). */
  introducedBy: string;
}

export const SETTINGS_CATALOG: readonly SettingsCatalogEntry[] = [
  {
    key: 'portfolio_margin_threshold_pct',
    default: 0.0,
    type: 'number',
    description:
      'Portfolio margin threshold (decimal pct). Products with marginPct <= this value are flagged as losing money.',
    introducedBy: 'HUB-1595',
  },
  {
    key: 'role_rename_compat_window_enabled',
    default: true,
    type: 'boolean',
    description:
      'Backward-compat window for tenant_admin → product_admin role rename. When true, JWT issuance + RBAC accept either role string. Flip to false after all in-flight JWTs have rotated past their TTL.', // tenant-admin-rename:historical
    introducedBy: 'HUB-1588',
  },
  {
    key: 'compliance_drift_threshold_pct',
    default: 10.0,
    type: 'number',
    description:
      'Compliance posture drop (pp) over the trailing 30-day window that triggers a drift signal in the portfolio grid + drill-in banners.',
    introducedBy: 'HUB-1622',
  },
  {
    key: 'sdk_stale_threshold_days',
    default: 30,
    type: 'number',
    description:
      'SDK reporter staleness window (days). Reporters whose lastReportedAt is older than this render as stale in HUB-1633 product breakdown.',
    introducedBy: 'HUB-1633',
  },
  {
    key: 'system_health_error_rate_threshold',
    default: 0.05,
    type: 'number',
    description:
      'Portfolio System Health errorRate threshold (decimal). Products with errorRate24h >= this value render as Degraded.',
    introducedBy: 'HUB-1574',
  },
  {
    key: 'customer_health_red_threshold',
    default: 0.7,
    type: 'number',
    description:
      'Customer Health badge red (At risk) threshold. churnRiskScore >= this value renders red.',
    introducedBy: 'HUB-1680',
  },
  {
    key: 'customer_health_yellow_threshold',
    default: 0.4,
    type: 'number',
    description:
      'Customer Health badge yellow (Watch) threshold. churnRiskScore >= this value (but below red) renders yellow.',
    introducedBy: 'HUB-1680',
  },
  {
    key: 'customer_health_stale_days',
    default: 14,
    type: 'number',
    description:
      'Customer Health stale-no-activity window in days. Tenants with no usage events in 2x this value are forced red regardless of score.',
    introducedBy: 'HUB-1680',
  },
  {
    key: 'jira_project_key_by_product',
    default: {
      contenthelm: 'CH',
      hub: 'HUB',
      synapz: 'SYNC',
      launchkit: 'LK',
    },
    type: 'json',
    description:
      'Mapping from HUB product key → Atlassian project key (e.g., contenthelm → CH). Consumed by HUB-1593 jiraIntegrationService at request time to resolve which Atlassian project to query per HUB-tracked product.',
    introducedBy: 'HUB-1592',
  },
] as const;

/** Look up a catalog entry by key. Returns undefined for unknown keys. */
export function getCatalogEntry(key: string): SettingsCatalogEntry | undefined {
  return SETTINGS_CATALOG.find((entry) => entry.key === key);
}

/** Asserts a JSONB-decoded value matches its catalog entry's type contract. */
export function assertValueType(
  key: string,
  value: unknown,
): value is number | boolean | string {
  const entry = getCatalogEntry(key);
  if (!entry) return false;
  if (entry.type === 'number') return typeof value === 'number';
  if (entry.type === 'boolean') return typeof value === 'boolean';
  if (entry.type === 'string') return typeof value === 'string';
  if (entry.type === 'json') return typeof value === 'object' && value !== null;
  return false;
}
