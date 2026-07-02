// Authorized by HUB-1664 (E-FE-6 S5) — FE-side mirror of the shared BE
// settings catalog (canonical source: hub/src/types/settingsCatalog.ts).
// The mirror ships the v0.1 known-key list so HUB-1664's editor can pick
// the correct control per setting; unknown keys fall through to the raw
// JSON textarea per FR-011.
//
// HUB-1545 tech debt candidate: expose the BE catalog as an HTTP endpoint
// so the FE fetches instead of mirroring; today the mirror MUST stay in
// sync with the BE file by hand when new well-known keys land.

export type SettingsValueType = 'number' | 'boolean' | 'string' | 'json';

export interface SettingsCatalogEntry {
  key: string;
  default: unknown;
  type: SettingsValueType;
  description: string;
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
      'Backward-compat window for tenant_admin → product_admin role rename. When true, JWT issuance + RBAC accept either role string.',
    introducedBy: 'HUB-1588',
  },
  {
    key: 'compliance_drift_threshold_pct',
    default: 10.0,
    type: 'number',
    description:
      'Compliance posture drop (pp) over the trailing 30-day window that triggers a drift signal.',
    introducedBy: 'HUB-1622',
  },
  {
    key: 'sdk_stale_threshold_days',
    default: 30,
    type: 'number',
    description:
      'SDK reporter staleness window (days). Reporters whose lastReportedAt is older render as stale.',
    introducedBy: 'HUB-1633',
  },
  {
    key: 'system_health_error_rate_threshold',
    default: 0.05,
    type: 'number',
    description:
      'Portfolio System Health errorRate threshold (decimal). Products with errorRate24h >= this render as Degraded.',
    introducedBy: 'HUB-1574',
  },
  {
    key: 'customer_health_red_threshold',
    default: 0.7,
    type: 'number',
    description:
      'Customer Health badge red (At risk) threshold. churnRiskScore >= this renders red.',
    introducedBy: 'HUB-1680',
  },
  {
    key: 'customer_health_yellow_threshold',
    default: 0.4,
    type: 'number',
    description:
      'Customer Health badge yellow (Watch) threshold. churnRiskScore >= this (but below red) renders yellow.',
    introducedBy: 'HUB-1680',
  },
  {
    key: 'customer_health_stale_days',
    default: 14,
    type: 'number',
    description:
      'Customer Health stale-no-activity window in days. Tenants with no usage events in 2x this value are forced red.',
    introducedBy: 'HUB-1680',
  },
  {
    key: 'jira_project_key_by_product',
    default: {},
    type: 'json',
    description:
      'Mapping from HUB product key → Atlassian project key (e.g., contenthelm → CH).',
    introducedBy: 'HUB-1592',
  },
  {
    key: 'pricing_elasticity_coefficient',
    default: -1.0,
    type: 'number',
    description:
      'Plan-advisor pricing elasticity coefficient (dimensionless). Signed magnitude used by the scenario compute.',
    introducedBy: 'HUB-1660',
  },
] as const;

export function getCatalogEntry(key: string): SettingsCatalogEntry | undefined {
  return SETTINGS_CATALOG.find((e) => e.key === key);
}
