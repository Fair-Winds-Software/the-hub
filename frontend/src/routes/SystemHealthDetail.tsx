// Authorized by HUB-1676 (E-FE-7 S3) — System Health drill-in shell at
// /console/system-health/:productId. Renders the product header, a back
// link to the HUB-1675 portfolio grid, a summary badge mirroring the S2
// health status, and a 4-tab navigation (Liveness / Errors / Queues /
// Webhooks) mapped to per-tab sub-routes via <Outlet>.
//
// Tabs are:
//   - semantically-tab-shaped (<nav aria-label> + role='tablist' +
//     role='tab' + aria-selected) so assistive tech understands the
//     pattern without hijacking browser focus.
//   - independently deep-linkable via the sub-paths
//     /liveness /errors /queues /webhooks; a bare
//     /console/system-health/:productId redirects to /liveness by
//     default (Ironclad 'first tab is the default' pattern).
//   - lazy-populated: only the active sub-route's element is rendered by
//     React Router, so the sibling tabs' data fetches don't fire on
//     drill-in entry.
//
// Product name + badge are joined from the HUB-1674 /portfolio endpoint
// so the header stays in sync with the S2 grid; if the endpoint 403s,
// AccessDeniedPage renders instead. Placeholder sub-route components
// (Liveness/Errors/Queues/Webhooks) will be swapped by HUB-1677 (S4) +
// HUB-1678 (S5) — the shell contract stays stable so those stories can
// land in either order.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useParams,
} from 'react-router-dom';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import { HealthTabErrorBoundary } from './systemHealth/HealthTabErrorBoundary';

const PORTFOLIO_HEALTH_PATH = '/api/v1/admin/system-health/portfolio';
const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'System Health · product | HUB Console';

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
  errorRate24h: number;
}
interface HealthResponse {
  products: HealthRow[];
  meta: { threshold: number };
}

interface Tab {
  id: 'liveness' | 'errors' | 'queues' | 'webhooks';
  label: string;
}

export const SYSTEM_HEALTH_DETAIL_TABS: readonly Tab[] = [
  { id: 'liveness', label: 'Liveness' },
  { id: 'errors', label: 'Errors' },
  { id: 'queues', label: 'Queues' },
  { id: 'webhooks', label: 'Webhooks' },
] as const;

type HealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'not-found' }
  | { kind: 'ready'; productName: string; status: HealthStatus };

function classifyStatus(
  row: HealthRow | undefined,
  threshold: number,
): HealthStatus {
  if (!row) return 'unknown';
  if (!row.reachable) return 'unreachable';
  if (row.errorRate24h >= threshold) return 'degraded';
  return 'healthy';
}

function StatusBadge({ status }: { status: HealthStatus }): React.ReactElement {
  if (status === 'healthy') {
    return (
      <span
        data-testid="detail-status-healthy"
        className="inline-flex items-center gap-1 rounded-full border border-seafoam/40 bg-seafoam/10 px-2 py-0.5 text-xs font-body text-seafoam"
      >
        <span aria-hidden="true">✓</span> Healthy
      </span>
    );
  }
  if (status === 'degraded') {
    return (
      <span
        data-testid="detail-status-degraded"
        className="inline-flex items-center gap-1 rounded-full border border-accent-brass/40 bg-accent-brass/10 px-2 py-0.5 text-xs font-body text-accent-brass"
      >
        <span aria-hidden="true">⚠</span> Degraded
      </span>
    );
  }
  if (status === 'unreachable') {
    return (
      <span
        data-testid="detail-status-unreachable"
        className="inline-flex items-center gap-1 rounded-full border border-ironwake/40 bg-ironwake/10 px-2 py-0.5 text-xs font-body text-ironwake"
      >
        <span aria-hidden="true">✕</span> Unreachable
      </span>
    );
  }
  return (
    <span
      data-testid="detail-status-unknown"
      className="inline-flex items-center rounded-full border border-deep-charcoal/20 bg-deep-charcoal/5 px-2 py-0.5 text-xs font-body text-deep-charcoal/70"
    >
      Unknown
    </span>
  );
}

export default function SystemHealthDetail(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const location = useLocation();

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
      const row = health.products.find((p) => p.productId === productId);
      const inPortfolio = portfolio.data.find((p) => p.productId === productId);
      if (!row && !inPortfolio) {
        setState({ kind: 'not-found' });
        return;
      }
      const productName = inPortfolio?.productName ?? productId;
      const status = classifyStatus(row, health.meta.threshold);
      setState({ kind: 'ready', productName, status });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Failed to load product context';
      setState({ kind: 'error', message });
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentTabId = useMemo<Tab['id']>(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    for (const tab of SYSTEM_HEALTH_DETAIL_TABS) {
      if (tab.id === last) return tab.id;
    }
    return 'liveness';
  }, [location.pathname]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="system-health-detail-page"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="system-health-detail-skeleton"
          className="h-24 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }
  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="this product's system health"
          backTo="/console/system-health"
          backLabel="Back to portfolio grid"
        />
      </div>
    );
  }
  if (state.kind === 'not-found') {
    return (
      <div
        id="main-content"
        data-testid="system-health-detail-not-found"
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal"
      >
        <p className="font-medium">Product not found in the health portfolio.</p>
        <Link
          to="/console/system-health"
          className="mt-2 inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Back to portfolio grid
        </Link>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="system-health-detail-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load product context.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="system-health-detail-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      id="main-content"
      data-testid="system-health-detail-page"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-2">
        <Link
          to="/console/system-health"
          data-testid="system-health-detail-back"
          className="w-fit text-xs font-body text-primary-navy underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          ← Back to System Health
        </Link>
        <div className="flex items-center gap-3">
          <h1
            data-testid="system-health-detail-heading"
            className="font-heading text-2xl text-primary-navy"
          >
            {state.productName}
          </h1>
          <StatusBadge status={state.status} />
        </div>
      </header>

      <nav
        aria-label="System Health tabs"
        data-testid="system-health-detail-tabs"
      >
        <ul role="tablist" className="flex gap-1 border-b border-deep-charcoal/15">
          {SYSTEM_HEALTH_DETAIL_TABS.map((tab) => (
            <li key={tab.id} role="presentation">
              <NavLink
                to={`/console/system-health/${productId}/${tab.id}`}
                role="tab"
                aria-selected={currentTabId === tab.id}
                data-testid={`system-health-detail-tab-${tab.id}`}
                className={({ isActive }) =>
                  isActive
                    ? 'inline-block border-b-2 border-primary-navy px-3 py-1.5 text-sm font-body font-semibold text-primary-navy no-underline focus:outline-none focus:ring-2 focus:ring-accent-brass'
                    : 'inline-block px-3 py-1.5 text-sm font-body text-deep-charcoal/70 no-underline hover:text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass'
                }
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <section
        aria-label="Tab content"
        data-testid="system-health-detail-content"
      >
        <HealthTabErrorBoundary tabLabel={currentTabId}>
          <Outlet />
        </HealthTabErrorBoundary>
      </section>
    </div>
  );
}
