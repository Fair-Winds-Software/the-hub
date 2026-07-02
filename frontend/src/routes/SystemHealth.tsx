// Authorized by HUB-1675 (E-FE-7 S2) — Portfolio System Health grid at
// /console/system-health. Fetches the HUB-1674 portfolio roll-up and
// renders one triple-encoded status tile per product; tile click deep-
// links into the HUB-1676 drill-in.
//
// Health badge triple-encoding per FR-009:
//   green  ✓ Healthy       — reachable && errorRate24h < meta.threshold
//   yellow ⚠ Degraded      — reachable && errorRate24h >= meta.threshold
//   red    ✕ Unreachable   — !reachable
//
// Threshold-driven per FR-008: meta.threshold arrives in the response so
// the badge logic never needs a separate GET /admin/settings round-trip
// (single-source-of-truth pattern set by HUB-1674).
//
// No auto-refresh per Epic AC #5 — the "Refresh now" button is the only
// data-fresh path; a "Last refreshed" line surfaces the age of the
// displayed payload.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Product names: the S1 endpoint returns only productId (no
//      productName). The FE joins against the HUB-1700 portfolio
//      aggregator (same pattern as the plan-advisor + pricing screens)
//      to resolve the display label; if the aggregator times out the
//      tile falls back to the productId short-form so the health
//      status stays visible.
//
//   2. Client-side scope filter: HUB-1674 already scopes product_admin
//      server-side. The FE does not layer a second filter; the FE-side
//      'useRBACGuard' scope-filter documented in the spec is a
//      belt-and-braces pattern the current single-tenant model doesn't
//      require. HUB-1545 tech debt candidate if v0.2 introduces multi-
//      tenant product_admin scopes.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import { formatDate } from './productDetail/pricing-formatters';

const PORTFOLIO_HEALTH_PATH = '/api/v1/admin/system-health/portfolio';
const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'System Health | HUB Console';

interface PortfolioProduct {
  productId: string;
  productName: string;
}
interface PortfolioResponse {
  data: PortfolioProduct[];
}

interface HealthRow {
  productId: string;
  reachable: boolean;
  lastProbedAt: string;
  errorRate24h: number;
  lastErrorEvent: { timestamp: string; message: string } | null;
}
interface HealthResponse {
  products: HealthRow[];
  generatedAt: string;
  meta: { threshold: number };
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | {
      kind: 'ready';
      health: HealthResponse;
      productNames: Record<string, string>;
    };

type HealthStatus = 'healthy' | 'degraded' | 'unreachable';

function classify(row: HealthRow, threshold: number): HealthStatus {
  if (!row.reachable) return 'unreachable';
  if (row.errorRate24h >= threshold) return 'degraded';
  return 'healthy';
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function badgeClasses(status: HealthStatus): string {
  if (status === 'healthy') {
    return 'border-seafoam/40 bg-seafoam/10 text-seafoam';
  }
  if (status === 'degraded') {
    return 'border-accent-brass/40 bg-accent-brass/10 text-accent-brass';
  }
  return 'border-ironwake/40 bg-ironwake/10 text-ironwake';
}

interface HealthBadgeProps {
  status: HealthStatus;
  threshold: number;
}

function HealthBadge({ status, threshold }: HealthBadgeProps): React.ReactElement {
  const tooltip = `Threshold: ${(threshold * 100).toFixed(1)}% — configurable in Settings → HUB Settings (HUB-1664).`;
  const icon = status === 'healthy' ? '✓' : status === 'degraded' ? '⚠' : '✕';
  const label =
    status === 'healthy'
      ? 'Healthy'
      : status === 'degraded'
        ? 'Degraded'
        : 'Unreachable';
  return (
    <span
      data-testid={`system-health-badge-${status}`}
      title={tooltip}
      aria-label={`${label}. ${tooltip}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-body ${badgeClasses(status)}`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

interface ProductTileProps {
  row: HealthRow;
  productName: string;
  threshold: number;
}

function ProductTile({
  row,
  productName,
  threshold,
}: ProductTileProps): React.ReactElement {
  const status = classify(row, threshold);
  const pct = (row.errorRate24h * 100).toFixed(1);
  return (
    <Link
      to={`/console/system-health/${row.productId}`}
      data-testid={`system-health-tile-${row.productId}`}
      aria-label={`${productName} health: ${status}. ${pct}% errors in the last 24 hours.`}
      className="flex flex-col gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 no-underline transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent-brass"
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          data-testid={`system-health-tile-name-${row.productId}`}
          className="min-w-0 truncate font-heading text-base text-primary-navy underline decoration-primary-navy/40 underline-offset-2"
        >
          {productName}
        </h3>
        <HealthBadge status={status} threshold={threshold} />
      </div>
      <p className="text-xs font-body text-deep-charcoal/70">
        {row.reachable ? 'Reachable' : 'Unreachable'} · {pct}% errors in 24h
      </p>
      {row.lastErrorEvent && (
        <p
          data-testid={`system-health-tile-last-error-${row.productId}`}
          className="line-clamp-2 text-xs font-body text-deep-charcoal/60"
        >
          Last error: {row.lastErrorEvent.message}
        </p>
      )}
    </Link>
  );
}

export default function SystemHealth(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const [health, portfolio] = await Promise.all([
        apiClient.get<HealthResponse>(PORTFOLIO_HEALTH_PATH),
        apiClient
          .get<PortfolioResponse>(PORTFOLIO_PATH)
          .catch(() => ({ data: [] as PortfolioProduct[] })),
      ]);
      const productNames: Record<string, string> = {};
      for (const p of portfolio.data) productNames[p.productId] = p.productName;
      setState({ kind: 'ready', health, productNames });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Failed to load system health';
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return state.health.products;
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="system-health-page"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="system-health-skeleton"
          className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-md bg-deep-charcoal/5"
            />
          ))}
        </div>
      </div>
    );
  }

  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="System Health"
          backTo="/console/dashboard"
          backLabel="Back to dashboard"
        />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="system-health-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load System Health.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="system-health-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const { health, productNames } = state;
  return (
    <div
      id="main-content"
      data-testid="system-health-page"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">System Health</h1>
        <div className="flex items-center gap-2 text-xs font-body text-deep-charcoal/70">
          <span data-testid="system-health-generated-at">
            Last refreshed: {formatDate(health.generatedAt)}
          </span>
          <button
            type="button"
            data-testid="system-health-refresh"
            onClick={() => void load()}
            className="rounded border border-deep-charcoal/20 px-2 py-0.5 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Refresh now
          </button>
        </div>
      </header>

      {rows.length === 0 ? (
        <div
          data-testid="system-health-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          No products in scope. Ask Sammy for access.
        </div>
      ) : (
        <section aria-labelledby="system-health-grid-heading">
          <h2 id="system-health-grid-heading" className="sr-only">
            Product health tiles
          </h2>
          <div
            data-testid="system-health-grid"
            className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {rows.map((r) => (
              <ProductTile
                key={r.productId}
                row={r}
                productName={productNames[r.productId] ?? shortId(r.productId)}
                threshold={health.meta.threshold}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
