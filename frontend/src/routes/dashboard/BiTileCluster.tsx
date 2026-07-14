// Authorized by HUB-1809 (S7 of HUB-1785) — BI tile cluster for the Dashboard.
// Three MetricTiles fed by GET /api/v1/admin/bi/portfolio/summary:
//   - Total MRR (dollars from mrr_cents)
//   - Portfolio DAU
//   - Portfolio Churn (percent)
//
// Rendering rules:
//   - 403 from the endpoint → widget renders NOTHING (product_admin dashboards
//     silently hide the portfolio-scoped BI cluster; the per-product BI page
//     covers their scope).
//   - Any other fetch error → error banner with retry affordance via next poll.
//   - null values from the endpoint (empty portfolio, no rollups yet) → tiles
//     render "—" via MetricTile's built-in empty state.
//   - Auto-refetch every 5 minutes (matches the BI layer's near-real-time
//     target; the backend already caches for 60s so this is a light poll).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MetricTile } from '../../components/MetricTile';
import { apiClient } from '../../lib/api';
import { formatDollarsFromCents } from './dashboard-formatters';
import { PermissionDeniedError } from '../../lib/errors';

const PORTFOLIO_SUMMARY_PATH = '/api/v1/admin/bi/portfolio/summary';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface PortfolioSummary {
  as_of: string;
  mrr_cents: number | null;
  daily_active_users: number | null;
  churn_rate: number | null;
  per_product: unknown[];
}

interface Props {
  /** For test injection — production usage relies on the default apiClient GET. */
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
        // product_admin can't see the portfolio summary — hide the cluster silently.
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
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div data-testid="bi-tile-mrr">
          <MetricTile
            title="Total MRR"
            value={summary.mrr_cents !== null ? formatDollarsFromCents(summary.mrr_cents) : null}
            verdict="neutral"
          />
        </div>
        <div data-testid="bi-tile-dau">
          <MetricTile
            title="Portfolio DAU"
            value={formatCount(summary.daily_active_users)}
            verdict="neutral"
          />
        </div>
        <div data-testid="bi-tile-churn">
          <MetricTile
            title="Portfolio Churn"
            value={formatPercent(summary.churn_rate)}
            verdict="neutral"
          />
        </div>
      </div>
      <p data-testid="bi-tile-cluster-asof" className="text-xs text-deep-charcoal/50">
        As of {new Date(summary.as_of).toLocaleString()}
      </p>
    </section>
  );
}
