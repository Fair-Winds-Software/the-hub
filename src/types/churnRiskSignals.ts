// Authorized by HUB-1680 (E-FE-9 S1) — stable enum contract for churn-risk
// signals consumed by /admin/customer-health list + drill-in.
//
// Contract rules:
//   - Signal keys are STABLE strings. Renaming any of them is a breaking
//     change; a deploy that renames one must ship both-old-and-new until
//     downstream analytics / audit consumers migrate.
//   - contributesPoints is the score-weight the signal adds when active.
//     Sum is soft-capped at 1.0 by the score deriver — do not tune weights
//     above 1.0 in aggregate without updating deriveChurnRiskScore.
//   - severity is the FE-facing display severity for the drill-in signals
//     panel (S5). Not the same as contributesPoints — a low-severity
//     signal can still add meaningfully to the score if enough of them
//     accumulate.
//
// Spec deviation (per ironclad-engineer, documented for HUB-1680): the
// story listed a `plan_downgrade_recent` signal, but `plan_change_ledger`
// (migrations 004 + 040) has no direction column at v0.1 — we cannot
// reliably distinguish upgrades from downgrades from the row alone.
// Renamed to `plan_change_recent` (any plan change in 90d as a churn
// proxy) so the signal reflects what we can actually measure. Future
// migration adding a direction column can re-split.

export type ChurnRiskSignalKey =
  | 'declining_usage_30d'
  | 'payment_failure_recent'
  | 'plan_change_recent'
  | 'stale_no_activity'
  | 'advisor_recommends_save';

export type ChurnRiskSeverity = 'high' | 'medium' | 'low';

export interface ChurnRiskSignalDef {
  key: ChurnRiskSignalKey;
  label: string;
  severity: ChurnRiskSeverity;
  contributesPoints: number;
}

export const CHURN_RISK_SIGNALS: Record<ChurnRiskSignalKey, ChurnRiskSignalDef> = {
  declining_usage_30d: {
    key: 'declining_usage_30d',
    label: 'Usage down >30% vs prior 30 days',
    severity: 'high',
    contributesPoints: 0.25,
  },
  payment_failure_recent: {
    key: 'payment_failure_recent',
    label: 'Payment failed in the last 30 days',
    severity: 'high',
    contributesPoints: 0.3,
  },
  plan_change_recent: {
    key: 'plan_change_recent',
    label: 'Plan changed in the last 90 days',
    severity: 'medium',
    contributesPoints: 0.15,
  },
  stale_no_activity: {
    key: 'stale_no_activity',
    label: 'No activity for 14+ days',
    severity: 'high',
    contributesPoints: 0.3,
  },
  advisor_recommends_save: {
    key: 'advisor_recommends_save',
    label: 'Plan Advisor recommends a save action',
    severity: 'high',
    contributesPoints: 0.25,
  },
};
