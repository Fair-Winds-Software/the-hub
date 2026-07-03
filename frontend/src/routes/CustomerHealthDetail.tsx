// Authorized by HUB-1683 (E-FE-9 S4) — Customer Health drill-in shell at
// /console/customer-health/:tenantId. Fetches HUB-1680's per-tenant
// endpoint and renders a two-column layout: usage timeline chart (left)
// + signals panel (right, HUB-1684 S5).
//
// RBAC: server-authoritative — HUB-1680 emits 403 for cross-tenant
// requests. On 403 the page routes back to the list with a toast.
//
// productId comes from the query string (parents like the S2 list embed
// it in the row link). If missing, the fetch 400s and we surface a
// dedicated "productId required" error so the operator can go back.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import {
  formatCurrency,
  formatRelativeTime,
  formatScore,
} from './customerHealth/customer-health-formatters';
import {
  UsageTimelineChart,
  type UsageTimelinePoint,
} from './customerHealth/UsageTimelineChart';
import {
  CustomerHealthSignalsPanel,
  type DrillInSignal,
} from './customerHealth/CustomerHealthSignalsPanel';

const HEALTH_DETAIL_PATH = '/api/v1/admin/customer-health';
const PAGE_TITLE = 'Customer Health · Detail | HUB Console';

export type HealthBadge = 'red' | 'yellow' | 'green';

export interface HealthDetailResponse {
  tenant: { id: string; name: string };
  product: { id: string; name: string };
  currentPlan: { key: string | null };
  mrr: { cents: number | null; currency: string };
  healthBadge: HealthBadge;
  churnRiskScore: number;
  lastActiveAt: string | null;
  lastAdvisorRunAt: string | null;
  signals: DrillInSignal[];
  usageTimeline90d: UsageTimelinePoint[];
  meta: { thresholds: { red: number; yellow: number; staleDays: number } };
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'not-found' }
  | { kind: 'ready'; payload: HealthDetailResponse };

interface DetailBadgeProps {
  badge: HealthBadge;
}

function DetailBadge({ badge }: DetailBadgeProps): React.ReactElement {
  const displayLabel =
    badge === 'red' ? 'At risk' : badge === 'yellow' ? 'Watch' : 'Healthy';
  const icon = badge === 'red' ? '✕' : badge === 'yellow' ? '⚠' : '✓';
  const classes =
    badge === 'red'
      ? 'border-ironwake/40 bg-ironwake/10 text-ironwake'
      : badge === 'yellow'
        ? 'border-accent-brass/40 bg-accent-brass/10 text-accent-brass'
        : 'border-seafoam/40 bg-seafoam/10 text-seafoam';
  return (
    <span
      data-testid={`customer-health-detail-badge-${badge}`}
      aria-label={`Risk level: ${displayLabel}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-body ${classes}`}
    >
      <span aria-hidden="true">{icon}</span>
      {displayLabel}
    </span>
  );
}

export default function CustomerHealthDetail(): React.ReactElement {
  const { tenantId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const productId = searchParams.get('productId');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const navigate = useNavigate();

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!productId) {
      setState({
        kind: 'error',
        message: 'productId query is required — return to the list to pick a row.',
      });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const payload = await apiClient.get<HealthDetailResponse>(
        `${HEALTH_DETAIL_PATH}/${tenantId}?productId=${productId}`,
      );
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        // Immediately route back to the list with a note; the list is the
        // safe re-entry surface for a scope-mismatched operator.
        setTimeout(
          () =>
            navigate('/console/customer-health', {
              replace: true,
              state: { toast: "You don't have access to that tenant." },
            }),
          800,
        );
        return;
      }
      // 404 comes as a generic Error from the API client; surface it distinctly
      // so the page can show the not-found template.
      const message =
        err instanceof Error ? err.message : 'Failed to load customer health';
      if (message.toLowerCase().includes('not found')) {
        setState({ kind: 'not-found' });
        return;
      }
      setState({ kind: 'error', message });
    }
  }, [tenantId, productId, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  const staleLabel = useMemo(() => {
    if (state.kind !== 'ready') return '';
    return formatRelativeTime(state.payload.lastActiveAt);
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="customer-health-detail-page-loading"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="customer-health-detail-skeleton"
          className="h-64 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }
  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="Customer Health"
          backTo="/console/customer-health"
          backLabel="Back to list"
        />
      </div>
    );
  }
  if (state.kind === 'not-found') {
    return (
      <div
        id="main-content"
        data-testid="customer-health-detail-not-found"
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
      >
        <p className="font-medium">Tenant + product pair not found.</p>
        <Link
          to="/console/customer-health"
          className="mt-2 inline-block text-primary-navy underline underline-offset-2"
        >
          Back to list
        </Link>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="customer-health-detail-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load Customer Health.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="customer-health-detail-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const { payload } = state;
  return (
    <div
      id="main-content"
      data-testid="customer-health-detail-page"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-2 border-b border-deep-charcoal/15 pb-4">
        <Link
          to="/console/customer-health"
          data-testid="customer-health-detail-back"
          className="text-xs font-body text-primary-navy underline underline-offset-2"
        >
          ← Back to Customer Health
        </Link>
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1
              data-testid="customer-health-detail-heading"
              className="font-heading text-2xl text-primary-navy"
            >
              {payload.tenant.name}
            </h1>
            <p className="text-xs font-body text-deep-charcoal/70">
              {payload.product.name} · plan{' '}
              <code className="font-mono">{payload.currentPlan.key ?? '—'}</code>{' '}
              · MRR {formatCurrency(payload.mrr.cents)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DetailBadge badge={payload.healthBadge} />
            <span
              data-testid="customer-health-detail-score"
              className="rounded-full border border-deep-charcoal/15 bg-white px-2 py-0.5 text-xs font-mono text-deep-charcoal"
              title="Churn risk score, 0.00–1.00"
            >
              Score {formatScore(payload.churnRiskScore)}
            </span>
            <span className="text-xs font-body text-deep-charcoal/70">
              Last active {staleLabel}
            </span>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <div data-testid="customer-health-detail-left" className="flex flex-col gap-3">
          <UsageTimelineChart data={payload.usageTimeline90d} />
        </div>
        <div data-testid="customer-health-detail-right" className="flex flex-col gap-3">
          <CustomerHealthSignalsPanel
            signals={payload.signals}
            totalScore={payload.churnRiskScore}
            lastAdvisorRunAt={payload.lastAdvisorRunAt}
            tenantId={payload.tenant.id}
            productId={payload.product.id}
          />
        </div>
      </div>
    </div>
  );
}
