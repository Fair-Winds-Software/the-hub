// Authorized by HUB-1645 (E-FE-2 S2) — Portfolio summary widget rendered inside
// the HUB-1644 dashboard shell's portfolio-summary region. Composes:
//   1. A MetricTile row (HUB-1620) for the three at-a-glance KPIs.
//   2. A "losing money" alert banner (triple-encoded per HUB-1571 tokens +
//      role="alert" / aria-live="polite") shown ONLY when the portfolio-
//      margin endpoint returns `portfolio.losingMoney === true`.
//
// Spec deviations (documented per ironclad-engineer + flagged to HUB-1545
// tech debt):
//
//   1. Response shape from GET /api/v1/admin/advisor/portfolio/summary
//      (verified at src/routes/admin/advisor.ts:45) does NOT surface a
//      top-level `mrr`, `revenueLast30d`, `marginPct`, or MoM `direction`.
//      What it DOES surface: `product_cards[].mrr_cents`,
//      `open_recommendations`, `margin_health[]`, `churn_risk[]`. The
//      widget therefore adapts the three tiles to what's actually
//      available: Total MRR (sum of mrr_cents), Open Recommendations,
//      Products Under Watch (margin_health.length + churn_risk.length).
//      Revenue-30d and the MoM direction arrow are deferred until the
//      BE endpoint carries those fields — tracked as HUB-1545 tech debt
//      per the spec's endpoint-verification caveat.
//
//   2. GET /api/v1/admin/analytics/portfolio-margin is spec'd by HUB-1556
//      FR-011 but not yet built at HUB-1645 implementation time. Per the
//      spec's degrade rule ("if the margin endpoint is degraded or rate-
//      limited, the MetricTile row still renders"), a 404 / network error
//      from this endpoint suppresses the losing-money banner silently and
//      the tile row still resolves. The FE is future-shape-ready: when the
//      endpoint returns { portfolio: { losingMoney, marginPct } } the
//      banner will fire without further FE changes.
//
// Widget isolation (FR-014, enforced by S7): every fetch here is wrapped
// so an error in this widget does NOT cascade to the S3 product grid or
// the S5 activity feed — each region owns its own boundary.
import { useCallback, useEffect, useState } from 'react';
import { MetricTile, type MetricVerdict } from '../../components/MetricTile';
import { apiClient } from '../../lib/api';
import { formatDollarsFromCents } from './dashboard-formatters';

const PORTFOLIO_SUMMARY_PATH = '/api/v1/admin/advisor/portfolio/summary';
const PORTFOLIO_MARGIN_PATH = '/api/v1/admin/analytics/portfolio-margin';

interface ProductCard {
  product_id: string;
  product_name: string;
  active_tenants: number;
  mrr_cents: number;
  open_recommendation_count: number;
  health_badge: 'green' | 'amber' | 'red';
}

interface ChurnRiskRow {
  tenant_id: string;
  product_id: string;
}

interface MarginHealthRow {
  discount_id: string;
  product_id: string;
}

interface PortfolioSummaryResponse {
  total_products: number;
  open_recommendations: number;
  upgrade_count: number;
  downgrade_count: number;
  product_cards: ProductCard[];
  churn_risk: ChurnRiskRow[];
  margin_health: MarginHealthRow[];
}

interface PortfolioMarginResponse {
  portfolio: {
    losingMoney: boolean;
    marginPct: number;
  };
}

type SummaryState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: PortfolioSummaryResponse };

// Margin fetch is intentionally optional — a failure never surfaces to the
// operator, it just suppresses the losing-money banner.
type MarginState =
  | { kind: 'idle' }
  | { kind: 'ready'; data: PortfolioMarginResponse['portfolio'] };

function LosingMoneyBanner({
  marginPct,
}: {
  marginPct: number;
}): React.ReactElement {
  const formatted = marginPct.toFixed(1);
  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="losing-money-banner"
      className="flex items-start gap-3 rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
    >
      {/* Triple-encoded per Ironclad Interface: color + icon + text. */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        aria-hidden="true"
        className="mt-0.5 shrink-0"
        data-testid="losing-money-icon"
      >
        <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <line x1="9" y1="5" x2="9" y2="10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="9" cy="12.5" r="1" fill="currentColor" />
      </svg>
      <p className="font-medium" data-testid="losing-money-text">
        Portfolio is losing money: margin{' '}
        <span data-testid="losing-money-margin-pct">{formatted}%</span>
      </p>
    </div>
  );
}

export function PortfolioSummaryWidget(): React.ReactElement {
  const [summary, setSummary] = useState<SummaryState>({ kind: 'loading' });
  const [margin, setMargin] = useState<MarginState>({ kind: 'idle' });

  const fetchSummary = useCallback(async (): Promise<void> => {
    setSummary({ kind: 'loading' });
    try {
      const res =
        await apiClient.get<PortfolioSummaryResponse>(PORTFOLIO_SUMMARY_PATH);
      setSummary({ kind: 'ready', data: res });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load portfolio summary';
      setSummary({ kind: 'error', message });
    }
  }, []);

  const fetchMargin = useCallback(async (): Promise<void> => {
    try {
      const res =
        await apiClient.get<PortfolioMarginResponse>(PORTFOLIO_MARGIN_PATH);
      if (res?.portfolio) {
        setMargin({ kind: 'ready', data: res.portfolio });
      }
    } catch {
      // Silent — the losing-money banner is opt-in on the availability of
      // the /portfolio-margin endpoint. Absence just means no banner.
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
    void fetchMargin();
  }, [fetchSummary, fetchMargin]);

  if (summary.kind === 'loading') {
    return (
      <div
        data-testid="portfolio-summary-widget-loading"
        className="flex flex-col gap-3"
      >
        <div
          data-testid="portfolio-summary-widget-tiles-skeleton"
          className="grid grid-cols-1 gap-3 md:grid-cols-3"
        >
          <MetricTile title="Total MRR" value={null} loading />
          <MetricTile title="Open Recommendations" value={null} loading />
          <MetricTile title="Products Under Watch" value={null} loading />
        </div>
      </div>
    );
  }

  if (summary.kind === 'error') {
    return (
      <div
        role="alert"
        data-testid="portfolio-summary-widget-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load portfolio summary.</p>
        <p className="mt-1">{summary.message}</p>
        <button
          type="button"
          data-testid="portfolio-summary-widget-retry"
          onClick={() => void fetchSummary()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const data = summary.data;
  const totalMrrCents = data.product_cards.reduce(
    (sum, card) => sum + (card.mrr_cents ?? 0),
    0,
  );
  const productsUnderWatch = (() => {
    const seen = new Set<string>();
    for (const row of data.margin_health) seen.add(row.product_id);
    for (const row of data.churn_risk) seen.add(row.product_id);
    return seen.size;
  })();
  const openVerdict: MetricVerdict =
    data.open_recommendations === 0 ? 'success' : 'warning';
  const watchVerdict: MetricVerdict =
    productsUnderWatch === 0 ? 'success' : 'warning';

  return (
    <div
      data-testid="portfolio-summary-widget"
      className="flex flex-col gap-3"
    >
      {margin.kind === 'ready' && margin.data.losingMoney && (
        <LosingMoneyBanner marginPct={margin.data.marginPct} />
      )}

      <div
        data-testid="portfolio-summary-widget-tiles"
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
      >
        <MetricTile
          title="Total MRR"
          value={formatDollarsFromCents(totalMrrCents)}
          verdict="neutral"
          footer={
            <span data-testid="portfolio-summary-mrr-footer">
              across {data.product_cards.length} products
            </span>
          }
        />
        <MetricTile
          title="Open Recommendations"
          value={data.open_recommendations}
          verdict={openVerdict}
          footer={
            <span data-testid="portfolio-summary-open-recs-footer">
              {data.upgrade_count} upgrade · {data.downgrade_count} downgrade
            </span>
          }
        />
        <MetricTile
          title="Products Under Watch"
          value={productsUnderWatch}
          verdict={watchVerdict}
          footer={
            <span data-testid="portfolio-summary-watch-footer">
              {data.margin_health.length} margin · {data.churn_risk.length} churn signals
            </span>
          }
        />
      </div>
    </div>
  );
}
