// Per-product BI drill-in page.
// Route: /console/products/:productId/bi
// Composition (top → bottom):
//   1. Page heading + health badge (from GET /bi/products/:productId/health)
//   2. At-a-glance tile row (MRR / Active Customers / DAU / Churn) for THIS
//      product, pulled from /bi/portfolio/summary.per_product. Each tile
//      carries an Info popover (definition / formula / source / verdicts).
//   3. Metric picker + Window + Range + Info popover for the picked metric.
//   4. TimelineChart driven by GET /bi/products/:productId/trends?…
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { TimelineChart, type TimelinePoint } from '../../components/TimelineChart';
import { MetricTile } from '../../components/MetricTile';
import {
  MetricInfoPopover,
  type MetricInfoContent,
} from '../../components/MetricInfoPopover';
import { formatDollarsFromCents } from '../dashboard/dashboard-formatters';

type HealthState = 'ok' | 'degraded' | 'down' | 'unknown';
type RollupWindow = 'hourly' | 'daily';
type Range = '7d' | '30d' | '90d';

interface CatalogEntry {
  name: string;
  description: string;
  type: string;
  rollup: string;
}

interface CatalogResponse {
  catalog: CatalogEntry[];
}

interface HealthResponse {
  product_id: string;
  health: HealthState;
  as_of: string;
  reason: string | null;
}

interface TrendPoint {
  bucket_start: string;
  value: number | null;
  sample_count: number;
}

interface TrendResponse {
  product_id: string;
  metric: string;
  window: RollupWindow;
  range: Range;
  series: TrendPoint[];
}

interface PortfolioProductSummary {
  product_id: string;
  name: string;
  mrr_cents: number | null;
  dau: number | null;
  churn_rate: number | null;
  active_customers: number | null;
  health: HealthState;
}

interface PortfolioSummary {
  per_product: PortfolioProductSummary[];
}

interface Fetchers {
  catalog?: () => Promise<CatalogResponse>;
  health?: (productId: string) => Promise<HealthResponse>;
  trends?: (
    productId: string,
    params: { metric: string; window: RollupWindow; range: Range },
  ) => Promise<TrendResponse>;
  portfolio?: () => Promise<PortfolioSummary>;
}

interface Props {
  fetchers?: Fetchers;
  productIdOverride?: string;
}

const PAGE_TITLE = 'Product BI | HUB Console';

const HEALTH_STYLES: Record<HealthState, string> = {
  ok: 'bg-green-100 text-green-900 border-green-300',
  degraded: 'bg-amber-100 text-amber-900 border-amber-300',
  down: 'bg-red-100 text-red-900 border-red-300',
  unknown: 'bg-gray-100 text-gray-700 border-gray-300',
};

// ── Per-metric Info popover content (product-scope wording) ─────────────────

const SOURCE_ROLLUP = 'metric_rollups (daily bucket, last-value semantics)';

const PRODUCT_MRR_INFO: MetricInfoContent = {
  definition: 'Monthly Recurring Revenue for this product only.',
  formula: 'Most-recent daily mrr_cents rollup for this product',
  source: SOURCE_ROLLUP,
};

const PRODUCT_ACTIVE_CUSTOMERS_INFO: MetricInfoContent = {
  definition: 'Paying customers currently subscribed to this product.',
  formula: 'Most-recent daily active_customers rollup for this product',
  source: SOURCE_ROLLUP,
};

const PRODUCT_DAU_INFO: MetricInfoContent = {
  definition: 'Unique users active in this product over the past 24 hours.',
  formula: 'Most-recent daily daily_active_users rollup for this product',
  source: SOURCE_ROLLUP,
};

const PRODUCT_CHURN_INFO: MetricInfoContent = {
  definition:
    'Fraction of paying customers of this product who cancelled in the period.',
  formula: 'Most-recent daily churn_rate rollup for this product',
  source: SOURCE_ROLLUP,
  verdictLegend: [
    { label: 'healthy', meaning: '< 2% monthly (SaaS benchmark)' },
    { label: 'warning', meaning: '2% – 5%' },
    { label: 'error', meaning: '> 5%' },
    { label: 'neutral', meaning: 'shown when threshold band is not configured' },
  ],
};

// Catalog-name → Info popover mapping for the metric picker.
const CHART_METRIC_INFO: Record<string, MetricInfoContent> = {
  mrr_cents: {
    definition: 'Monthly Recurring Revenue timeline for this product.',
    formula: 'Most-recent value inside each bucket window',
    source: SOURCE_ROLLUP,
  },
  active_customers: {
    definition: 'Paying customer count timeline for this product.',
    formula: 'Most-recent active_customers value inside each bucket window',
    source: SOURCE_ROLLUP,
  },
  daily_active_users: {
    definition: 'DAU over time for this product.',
    formula: 'SUM of daily_active_users events in each bucket window',
    source: SOURCE_ROLLUP,
  },
  churn_rate: {
    definition: 'Churn rate over time for this product.',
    formula: 'AVG of churn_rate events in each bucket window',
    source: SOURCE_ROLLUP,
    verdictLegend: [
      { label: 'healthy', meaning: '< 2% monthly (SaaS benchmark)' },
      { label: 'warning', meaning: '2% – 5%' },
      { label: 'error', meaning: '> 5%' },
      { label: 'neutral', meaning: 'shown when threshold band is not configured' },
    ],
  },
  logins: {
    definition: 'Successful login events over time.',
    formula: 'SUM of login events per bucket window',
    source: SOURCE_ROLLUP,
  },
  feature_adoption: {
    definition:
      'Fraction of DAU that engaged with a named feature. Requires a `feature` dimension on the event.',
    formula: 'AVG of feature_adoption events per bucket window',
    source: SOURCE_ROLLUP,
  },
  app_health_status: {
    definition:
      'Synthetic health check pushed by the product. Powers the health badge at the top of the page.',
    formula: 'Most-recent enum value (ok | degraded | down) per bucket window',
    source: SOURCE_ROLLUP,
    verdictLegend: [
      { label: 'healthy', meaning: 'value = ok' },
      { label: 'warning', meaning: 'value = degraded' },
      { label: 'error', meaning: 'value = down' },
      { label: 'neutral', meaning: 'no recent push' },
    ],
  },
};

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

function churnVerdict(
  value: number | null,
): 'success' | 'warning' | 'error' | 'neutral' {
  if (value === null) return 'neutral';
  if (value < 0.02) return 'success';
  if (value <= 0.05) return 'warning';
  return 'error';
}

function chartMetricInfoFor(
  metricName: string,
  catalog: CatalogEntry[] | null,
): MetricInfoContent {
  const known = CHART_METRIC_INFO[metricName];
  if (known) return known;
  const catEntry = catalog?.find((c) => c.name === metricName);
  return {
    definition: catEntry?.description ?? 'No description registered in the metric catalog.',
    formula: catEntry
      ? `${catEntry.rollup.toUpperCase()} of ${catEntry.name} events per bucket`
      : 'unknown',
    source: SOURCE_ROLLUP,
  };
}

export default function ProductBiPage({
  fetchers,
  productIdOverride,
}: Props = {}): React.ReactElement {
  if (typeof document !== 'undefined' && document.title !== PAGE_TITLE) {
    document.title = PAGE_TITLE;
  }
  const params = useParams();
  const productId = productIdOverride ?? params['productId'] ?? '';

  const eff = useMemo<Required<Fetchers>>(
    () => ({
      catalog:
        fetchers?.catalog ??
        (() => apiClient.get<CatalogResponse>('/api/v1/admin/bi/catalog')),
      health:
        fetchers?.health ??
        ((pid: string) =>
          apiClient.get<HealthResponse>(`/api/v1/admin/bi/products/${pid}/health`)),
      trends:
        fetchers?.trends ??
        ((pid: string, q: { metric: string; window: RollupWindow; range: Range }) =>
          apiClient.get<TrendResponse>(
            `/api/v1/admin/bi/products/${pid}/trends?metric=${encodeURIComponent(q.metric)}&window=${q.window}&range=${q.range}`,
          )),
      portfolio:
        fetchers?.portfolio ??
        (() => apiClient.get<PortfolioSummary>('/api/v1/admin/bi/portfolio/summary')),
    }),
    [fetchers],
  );

  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metric, setMetric] = useState<string>('daily_active_users');
  const [window, setWindow] = useState<RollupWindow>('daily');
  const [range, setRange] = useState<Range>('30d');
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [loadingTrend, setLoadingTrend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productSummary, setProductSummary] =
    useState<PortfolioProductSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [catRes, healthRes] = await Promise.all([
          eff.catalog(),
          eff.health(productId),
        ]);
        if (cancelled) return;
        setCatalog(catRes.catalog);
        if (!catRes.catalog.some((c) => c.name === metric) && catRes.catalog.length > 0) {
          setMetric(catRes.catalog[0]!.name);
        }
        setHealth(healthRes);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eff, productId]);

  // Pull this product's summary row for the at-a-glance tiles.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await eff.portfolio();
        if (cancelled) return;
        const row = res.per_product.find((p) => p.product_id === productId) ?? null;
        setProductSummary(row);
      } catch {
        // Silent — portfolio summary is an optional accessory here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eff, productId]);

  const loadTrend = useCallback(async () => {
    setLoadingTrend(true);
    setError(null);
    try {
      const res = await eff.trends(productId, { metric, window, range });
      setTrend(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingTrend(false);
    }
  }, [eff, productId, metric, window, range]);

  useEffect(() => {
    if (!productId) return;
    void loadTrend();
  }, [loadTrend, productId]);

  const chartData: TimelinePoint[] = useMemo(
    () =>
      (trend?.series ?? [])
        .filter((p) => p.value !== null)
        .map((p) => ({
          date: p.bucket_start.slice(0, 10),
          value: p.value as number,
        })),
    [trend],
  );

  const chartMetricInfo = chartMetricInfoFor(metric, catalog);

  return (
    <div
      id="main-content"
      data-testid="product-bi-page"
      className="flex flex-col gap-6"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1
            data-testid="product-bi-heading"
            className="font-heading text-2xl text-primary-navy"
          >
            Product BI
          </h1>
          <p className="font-body text-sm text-deep-charcoal/70">
            Time-series metrics + synthetic app health for this product.
          </p>
        </div>
        {health ? (
          <span
            data-testid="product-bi-health-badge"
            aria-label={`Health: ${health.health}${health.reason ? ` — ${health.reason}` : ''}`}
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${HEALTH_STYLES[health.health]}`}
          >
            {health.health}
          </span>
        ) : null}
      </header>

      <section
        data-testid="product-bi-tile-row"
        aria-label="Product at-a-glance metrics"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <div data-testid="product-bi-tile-mrr">
          <MetricTile
            title="MRR"
            value={
              productSummary?.mrr_cents != null
                ? formatDollarsFromCents(productSummary.mrr_cents)
                : null
            }
            verdict="neutral"
            info={PRODUCT_MRR_INFO}
          />
        </div>
        <div data-testid="product-bi-tile-active-customers">
          <MetricTile
            title="Active Customers"
            value={formatCount(productSummary?.active_customers ?? null)}
            verdict="neutral"
            info={PRODUCT_ACTIVE_CUSTOMERS_INFO}
          />
        </div>
        <div data-testid="product-bi-tile-dau">
          <MetricTile
            title="DAU"
            value={formatCount(productSummary?.dau ?? null)}
            verdict="neutral"
            info={PRODUCT_DAU_INFO}
          />
        </div>
        <div data-testid="product-bi-tile-churn">
          <MetricTile
            title="Churn Rate"
            value={formatPercent(productSummary?.churn_rate ?? null)}
            verdict={churnVerdict(productSummary?.churn_rate ?? null)}
            info={PRODUCT_CHURN_INFO}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-deep-charcoal/70 inline-flex items-center gap-1">
            Metric
            <MetricInfoPopover title={metric} content={chartMetricInfo} />
          </span>
          <select
            data-testid="product-bi-metric-picker"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            className="rounded-md border border-sailcloth/50 px-3 py-2"
          >
            {(catalog ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-deep-charcoal/70">Window</span>
          <select
            data-testid="product-bi-window-picker"
            value={window}
            onChange={(e) => setWindow(e.target.value as RollupWindow)}
            className="rounded-md border border-sailcloth/50 px-3 py-2"
          >
            <option value="hourly">hourly</option>
            <option value="daily">daily</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-deep-charcoal/70">Range</span>
          <select
            data-testid="product-bi-range-picker"
            value={range}
            onChange={(e) => setRange(e.target.value as Range)}
            className="rounded-md border border-sailcloth/50 px-3 py-2"
          >
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="90d">90 days</option>
          </select>
        </label>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="product-bi-error"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
        >
          {error}
        </p>
      ) : null}

      <section data-testid="product-bi-chart" aria-label={`${metric} ${window} ${range} trend`}>
        <TimelineChart
          data={chartData}
          yLabel={metric}
          height={280}
          loading={loadingTrend}
          error={error}
        />
      </section>
    </div>
  );
}
