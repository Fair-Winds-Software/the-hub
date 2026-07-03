// Authorized by HUB-1680 (E-FE-9 S1) — customer-health service. Owns:
//   - per-(tenant, product) signal derivation from usage_events + invoices
//     + plan_change_ledger + advisor_recommendations,
//   - churn-risk score derivation (weighted sum, soft-capped at 1.0),
//   - health-badge derivation from thresholds,
//   - 90-day daily usage timeline for the drill-in chart.
//
// The route in /routes/admin/customerHealth.ts fans out across visible
// (tenant, product) pairs, calls into these helpers, and wraps the result
// with pagination + meta.

import { getPool } from '../db/pool.js';
import { getLatestRecommendation } from './planAdvisorService.js';
import {
  CHURN_RISK_SIGNALS,
  type ChurnRiskSignalDef,
  type ChurnRiskSignalKey,
} from '../types/churnRiskSignals.js';

export interface CustomerHealthThresholds {
  red: number;
  yellow: number;
  staleDays: number;
}

export type HealthBadge = 'green' | 'yellow' | 'red';

export interface ActiveSignal extends ChurnRiskSignalDef {
  // Signal is always active in this list; contract type identical to
  // ChurnRiskSignalDef so FE consumers can render without a second lookup.
  active: true;
}

export interface CustomerHealthSignalsResult {
  score: number;
  signals: ActiveSignal[];
  lastActiveAt: string | null;
  lastAdvisorRunAt: string | null;
}

export async function deriveCustomerHealth(
  tenantId: string,
  productId: string,
): Promise<CustomerHealthSignalsResult> {
  const pool = getPool();
  const now = new Date();

  // ── Windowed counts + last-active — one query, no round-trip storm.
  const { rows: usageRows } = await pool.query<{
    last_active_at: Date | null;
    events_last_30d: string;
    events_prior_30d: string;
  }>(
    `SELECT
       MAX(occurred_at)                                                          AS last_active_at,
       COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '30 days')::TEXT   AS events_last_30d,
       COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '60 days'
                          AND occurred_at <  NOW() - INTERVAL '30 days')::TEXT   AS events_prior_30d
     FROM usage_events
     WHERE tenant_id = $1 AND product_id = $2`,
    [tenantId, productId],
  );

  const usage = usageRows[0]!;
  const lastActiveAt = usage.last_active_at;
  const last30 = parseInt(usage.events_last_30d, 10);
  const prior30 = parseInt(usage.events_prior_30d, 10);

  // ── Payment failure in the last 30 days.
  const { rows: pfRows } = await pool.query<{ has_recent: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM invoices
        WHERE tenant_id = $1 AND product_id = $2
          AND payment_failed_at IS NOT NULL
          AND payment_failed_at >= NOW() - INTERVAL '30 days'
     ) AS has_recent`,
    [tenantId, productId],
  );

  // ── Plan change in the last 90 days.
  const { rows: pcRows } = await pool.query<{ has_recent: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM plan_change_ledger
        WHERE tenant_id = $1 AND product_id = $2
          AND created_at >= NOW() - INTERVAL '90 days'
     ) AS has_recent`,
    [tenantId, productId],
  );

  // ── Advisor "save" recommendation — the E-FE-4 advisor engine writes
  // recommendation_type='downgrade' when it thinks the tenant is on too
  // large a plan; that's the closest analogue to a "save" signal at v0.1.
  const advisorLatest = await getLatestRecommendation(productId, tenantId);
  const advisorRecommendsSave =
    advisorLatest?.recommendation.recommendation_type === 'downgrade';
  const lastAdvisorRunAt = advisorLatest?.recommendation.week_start ?? null;

  // ── Signal composition.
  const active: ActiveSignal[] = [];

  const decliningUsage =
    prior30 > 0 && last30 < prior30 * 0.7 && prior30 >= 3;
  if (decliningUsage) {
    active.push({ ...CHURN_RISK_SIGNALS.declining_usage_30d, active: true });
  }
  if (pfRows[0]!.has_recent) {
    active.push({ ...CHURN_RISK_SIGNALS.payment_failure_recent, active: true });
  }
  if (pcRows[0]!.has_recent) {
    active.push({ ...CHURN_RISK_SIGNALS.plan_change_recent, active: true });
  }

  const staleNoActivity =
    lastActiveAt === null ||
    now.getTime() - lastActiveAt.getTime() > 14 * 24 * 60 * 60 * 1000;
  if (staleNoActivity) {
    active.push({ ...CHURN_RISK_SIGNALS.stale_no_activity, active: true });
  }
  if (advisorRecommendsSave) {
    active.push({ ...CHURN_RISK_SIGNALS.advisor_recommends_save, active: true });
  }

  const rawScore = active.reduce((sum, s) => sum + s.contributesPoints, 0);
  const score = Math.min(1, Math.round(rawScore * 100) / 100);

  return {
    score,
    signals: active,
    lastActiveAt: lastActiveAt ? lastActiveAt.toISOString() : null,
    lastAdvisorRunAt: lastAdvisorRunAt
      ? new Date(lastAdvisorRunAt).toISOString()
      : null,
  };
}

export function deriveHealthBadge(
  score: number,
  lastActiveAt: string | null,
  thresholds: CustomerHealthThresholds,
): HealthBadge {
  const now = Date.now();
  const activeAgeDays = lastActiveAt
    ? (now - new Date(lastActiveAt).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  const redByStale = activeAgeDays > thresholds.staleDays * 2;
  if (score >= thresholds.red || redByStale) return 'red';

  const yellowByStale = activeAgeDays > thresholds.staleDays;
  if (score >= thresholds.yellow || yellowByStale) return 'yellow';

  return 'green';
}

export interface UsageTimelineDay {
  date: string;
  eventCount: number;
  activeDays: number;
}

export async function getUsageTimeline90d(
  tenantId: string,
  productId: string,
): Promise<UsageTimelineDay[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ day: Date; event_count: string }>(
    `SELECT DATE_TRUNC('day', occurred_at) AS day, COUNT(*)::TEXT AS event_count
       FROM usage_events
      WHERE tenant_id = $1
        AND product_id = $2
        AND occurred_at >= NOW() - INTERVAL '90 days'
      GROUP BY day
      ORDER BY day ASC`,
    [tenantId, productId],
  );
  // activeDays: running count of days with ≥1 event within a 7-day
  // trailing window — helpful proxy for "how engaged is this tenant this
  // week?" that FE can render on a secondary axis.
  const perDay = rows.map((r) => ({
    date: r.day.toISOString().slice(0, 10),
    eventCount: parseInt(r.event_count, 10),
  }));
  return perDay.map((d, i) => {
    const from = Math.max(0, i - 6);
    const window = perDay.slice(from, i + 1);
    const activeDays = window.filter((w) => w.eventCount > 0).length;
    return { date: d.date, eventCount: d.eventCount, activeDays };
  });
}

export function isSignalKey(key: string): key is ChurnRiskSignalKey {
  return key in CHURN_RISK_SIGNALS;
}
