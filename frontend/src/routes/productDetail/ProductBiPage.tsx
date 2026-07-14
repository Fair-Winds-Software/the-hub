// Authorized by HUB-1810 (S8 of HUB-1785) — per-product BI drill-in page.
// Route: /console/products/:productId/bi
// Composition (top → bottom):
//   1. Page heading + health badge (from GET /bi/products/:productId/health)
//   2. Metric picker (from GET /bi/catalog) + Window (hourly|daily) + Range (7d|30d|90d)
//   3. TimelineChart driven by GET /bi/products/:productId/trends?…
// Empty state: chart shows "no data" via TimelineChart's built-in empty rendering.
// Error state: server-visible message in a role=alert region.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { TimelineChart, type TimelinePoint } from '../../components/TimelineChart';

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

interface Fetchers {
  catalog?: () => Promise<CatalogResponse>;
  health?: (productId: string) => Promise<HealthResponse>;
  trends?: (productId: string, params: { metric: string; window: RollupWindow; range: Range }) => Promise<TrendResponse>;
}

interface Props {
  /** For tests — override every fetch. */
  fetchers?: Fetchers;
  /** For tests — override the URL productId param (bypasses react-router). */
  productIdOverride?: string;
}

const PAGE_TITLE = 'Product BI | HUB Console';

const HEALTH_STYLES: Record<HealthState, string> = {
  ok: 'bg-green-100 text-green-900 border-green-300',
  degraded: 'bg-amber-100 text-amber-900 border-amber-300',
  down: 'bg-red-100 text-red-900 border-red-300',
  unknown: 'bg-gray-100 text-gray-700 border-gray-300',
};

export default function ProductBiPage({ fetchers, productIdOverride }: Props = {}): React.ReactElement {
  if (typeof document !== 'undefined' && document.title !== PAGE_TITLE) {
    document.title = PAGE_TITLE;
  }
  const params = useParams();
  const productId = productIdOverride ?? params['productId'] ?? '';

  const eff = useMemo<Required<Fetchers>>(
    () => ({
      catalog: fetchers?.catalog ?? (() => apiClient.get<CatalogResponse>('/api/v1/admin/bi/catalog')),
      health:
        fetchers?.health ??
        ((pid: string) => apiClient.get<HealthResponse>(`/api/v1/admin/bi/products/${pid}/health`)),
      trends:
        fetchers?.trends ??
        ((pid: string, q: { metric: string; window: RollupWindow; range: Range }) =>
          apiClient.get<TrendResponse>(
            `/api/v1/admin/bi/products/${pid}/trends?metric=${encodeURIComponent(q.metric)}&window=${q.window}&range=${q.range}`,
          )),
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

  // One-shot: load catalog + health.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [catRes, healthRes] = await Promise.all([eff.catalog(), eff.health(productId)]);
        if (cancelled) return;
        setCatalog(catRes.catalog);
        // Prefer the first catalog metric if daily_active_users isn't present.
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

  // Refetch whenever picker changes.
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

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-deep-charcoal/70">Metric</span>
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
