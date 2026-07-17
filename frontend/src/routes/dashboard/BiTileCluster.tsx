// BI tile cluster for the Dashboard — Tier-1 SaaS KPIs computed by the
// portfolio summary endpoint. Each tile carries an Info popover with
// definition / formula / source / verdict legend so operators can inspect
// what the number actually measures.
//
// Rendering rules:
//   - 403 from the endpoint → widget renders NOTHING (product_admin dashboards
//     silently hide the portfolio-scoped BI cluster; the per-product BI page
//     covers their scope).
//   - Any other fetch error → error banner with retry via next poll.
//   - null values → tiles render "—" via MetricTile's built-in empty state.
//   - Auto-refetch every 5 minutes (backend caches for 60s; this is a light poll).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MetricTile } from '../../components/MetricTile';
import type { MetricInfoContent } from '../../components/MetricInfoPopover';
import { apiClient } from '../../lib/api';
import { formatDollarsFromCents } from './dashboard-formatters';
import { PermissionDeniedError } from '../../lib/errors';

const PORTFOLIO_SUMMARY_PATH = '/api/v1/admin/bi/portfolio/summary';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface PortfolioSummary {
  as_of: string;
  mrr_cents: number | null;
  arr_cents: number | null;
  arpa_cents: number | null;
  clv_cents: number | null;
  revenue_growth_pct: number | null;
  active_customers: number | null;
  daily_active_users: number | null;
  churn_rate: number | null;
  per_product: unknown[];
}

interface Props {
  fetcher?: () => Promise<PortfolioSummary>;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

// ── Tile definitions (docs for the Info popover) ────────────────────────────

const SOURCE_ROLLUP = 'metric_rollups (daily bucket, last-value semantics)';

const MRR_INFO: MetricInfoContent = {
  definition:
    'Monthly Recurring Revenue — normalized monthly revenue from all active subscriptions across every product in the portfolio.',
  formula: 'SUM(most-recent daily mrr_cents rollup per product)',
  source: SOURCE_ROLLUP,
  verdictLegend: [
    { label: 'neutral', meaning: 'no threshold logic wired yet — value shown as-is' },
  ],
};

const ARR_INFO: MetricInfoContent = {
  definition:
    'Annual Run Rate — MRR projected out over a year, assuming no seasonality or growth. Standard SaaS shorthand for annualized revenue.',
  formula: 'MRR × 12',
  source: 'derived from portfolio MRR',
  verdictLegend: [{ label: 'neutral', meaning: 'derived directly from MRR' }],
};

const DAU_INFO: MetricInfoContent = {
  definition:
    'Portfolio Daily Active Users — sum of unique users active in a 24h window across every product.',
  formula: 'SUM(most-recent daily daily_active_users rollup per product)',
  source: SOURCE_ROLLUP,
};

const CHURN_INFO: MetricInfoContent = {
  definition:
    'Portfolio Churn Rate — fraction of paying customers who cancelled in the period, weighted by product DAU so bigger products count more.',
  formula: 'Σ(product_churn × product_DAU) / Σ(product_DAU)',
  source: SOURCE_ROLLUP,
  verdictLegend: [
    { label: 'healthy', meaning: '< 2% monthly (SaaS benchmark)' },
    { label: 'warning', meaning: '2% – 5%' },
    { label: 'error', meaning: '> 5%' },
    { label: 'neutral', meaning: 'shown when threshold band not yet configured' },
  ],
};

const ARPA_INFO: MetricInfoContent = {
  definition:
    'Average Revenue Per Account — average monthly revenue generated per paying customer.',
  formula: 'MRR ÷ active_customers',
  source:
    'derived from MRR + active_customers rollup (products must push active_customers to populate this tile)',
};

const CLV_INFO: MetricInfoContent = {
  definition:
    'Customer Lifetime Value — expected revenue from a single customer over the life of their subscription.',
  formula: '(1 ÷ churn_rate) × ARPA',
  source: 'derived from portfolio churn + ARPA',
  verdictLegend: [{ label: 'neutral', meaning: 'no LTV:CAC ratio computed (no CAC data yet)' }],
};

const REVENUE_GROWTH_INFO: MetricInfoContent = {
  definition:
    'Revenue Growth — percent change in portfolio MRR vs. the same MRR bucket ~30 days earlier.',
  formula: '(current_MRR − prior_MRR) ÷ prior_MRR',
  source: 'metric_rollups (compares two daily buckets 30d apart)',
  verdictLegend: [
    { label: 'healthy', meaning: '> 0% (growth)' },
    { label: 'error', meaning: '< 0% (contraction)' },
    { label: 'neutral', meaning: 'shown when no prior bucket exists yet' },
  ],
};

const ACTIVE_CUSTOMERS_INFO: MetricInfoContent = {
  definition:
    'Active Customers — total count of paying customers across every product at the end of the current bucket.',
  formula: 'SUM(most-recent daily active_customers rollup per product)',
  source: SOURCE_ROLLUP,
};

// ── Verdict thresholding ─────────────────────────────────────────────────────

function churnVerdict(value: number | null): 'success' | 'warning' | 'error' | 'neutral' {
  if (value === null) return 'neutral';
  if (value < 0.02) return 'success';
  if (value <= 0.05) return 'warning';
  return 'error';
}

function growthVerdict(value: number | null): 'success' | 'error' | 'neutral' {
  if (value === null) return 'neutral';
  return value >= 0 ? 'success' : 'error';
}

export function BiTileCluster({ fetcher }: Props = {}): React.ReactElement | null {
  const effectiveFetcher = useMemo(
    () => fetcher ?? (() => apiClient.get<PortfolioSummary>(PORTFOLIO_SUMMARY_PATH)),
    [fetcher],
  );

  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await effectiveFetcher();
      setSummary(next);
      setError(null);
    } catch (e) {
      if (e instanceof PermissionDeniedError) {
        setHidden(true);
        return;
      }
      setError((e as Error).message);
    }
  }, [effectiveFetcher]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (hidden) return null;

  if (error && !summary) {
    return (
      <div
        data-testid="bi-tile-cluster-error"
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
      >
        Failed to load portfolio BI: {error}
      </div>
    );
  }

  if (!summary) {
    return (
      <div
        data-testid="bi-tile-cluster-loading"
        className="rounded-md border border-sailcloth/30 bg-white p-4 text-sm text-deep-charcoal/70"
      >
        Loading portfolio BI…
      </div>
    );
  }

  return (
    <section
      data-testid="bi-tile-cluster"
      aria-label="Portfolio business intelligence"
      className="flex flex-col gap-2"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div data-testid="bi-tile-mrr">
          <MetricTile
            title="Total MRR"
            value={summary.mrr_cents !== null ? formatDollarsFromCents(summary.mrr_cents) : null}
            verdict="neutral"
            info={MRR_INFO}
          />
        </div>
        <div data-testid="bi-tile-arr">
          <MetricTile
            title="ARR"
            value={summary.arr_cents !== null ? formatDollarsFromCents(summary.arr_cents) : null}
            verdict="neutral"
            info={ARR_INFO}
          />
        </div>
        <div data-testid="bi-tile-revenue-growth">
          <MetricTile
            title="Revenue Growth (30d)"
            value={formatPercent(summary.revenue_growth_pct)}
            verdict={growthVerdict(summary.revenue_growth_pct)}
            info={REVENUE_GROWTH_INFO}
          />
        </div>
        <div data-testid="bi-tile-arpa">
          <MetricTile
            title="ARPA"
            value={summary.arpa_cents !== null ? formatDollarsFromCents(summary.arpa_cents) : null}
            verdict="neutral"
            info={ARPA_INFO}
          />
        </div>
        <div data-testid="bi-tile-clv">
          <MetricTile
            title="CLV"
            value={summary.clv_cents !== null ? formatDollarsFromCents(summary.clv_cents) : null}
            verdict="neutral"
            info={CLV_INFO}
          />
        </div>
        <div data-testid="bi-tile-active-customers">
          <MetricTile
            title="Active Customers"
            value={formatCount(summary.active_customers)}
            verdict="neutral"
            info={ACTIVE_CUSTOMERS_INFO}
          />
        </div>
        <div data-testid="bi-tile-dau">
          <MetricTile
            title="Portfolio DAU"
            value={formatCount(summary.daily_active_users)}
            verdict="neutral"
            info={DAU_INFO}
          />
        </div>
        <div data-testid="bi-tile-churn">
          <MetricTile
            title="Portfolio Churn"
            value={formatPercent(summary.churn_rate)}
            verdict={churnVerdict(summary.churn_rate)}
            info={CHURN_INFO}
          />
        </div>
      </div>
      <p data-testid="bi-tile-cluster-asof" className="text-xs text-deep-charcoal/50">
        As of {new Date(summary.as_of).toLocaleString()}
      </p>
    </section>
  );
}
