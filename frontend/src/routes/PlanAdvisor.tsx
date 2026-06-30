// Authorized by HUB-1638 (E-FE-4 S2) — /console/plan-advisor list view.
// Renders the HUB-1601 DataTable over the BE advisor list endpoint with
// product + outcome filters URL-synced (light-touch per HUB-1631 pattern).
//
// Spec deviations (documented per ironclad-engineer):
// 1. API endpoint: spec named GET /api/v1/admin/plan-advisor/runs. The
//    canonical HUB BE surface is /api/v1/admin/advisor/recommendations
//    (HUB-1699 E-BE-1 S22). Same query params (productId / outcome).
// 2. Outcome enum: spec listed "won / lost / no-action / pending". The BE
//    catalog is { applied, dismissed, auto_detected, won, lost, no_action }
//    and "pending" maps to outcome=null (no capture yet). The dropdown
//    surfaces the BE enum + an "Any outcome" default; `pending` is a UI
//    pseudo-value we translate to omitting outcome from the query.
// 3. Schema gaps at v0.1: the BE list shape returns null for currentPlan +
//    operatorEmail. The columns render '—' for those until the BE backfill
//    lands. Documented in HUB-1561 §6 caveat.
// 4. Per-role required productId: BE returns 400 when product_admin omits
//    productId. The Product dropdown's default "All my products" maps to
//    the operator's own products list — for product_admin we suggest the
//    first scoped product as the initial productId rather than omitting
//    (avoids a guaranteed 400 on mount). RBAC denial is handled by HUB-1642.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable, type ColumnDef } from '../components/DataTable';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';

const RECOMMENDATIONS_PATH = '/api/v1/admin/advisor/recommendations';
const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Plan Advisor | HUB Console';
const PAGE_SIZE = 50;

// "pending" is a UI pseudo-value that filters to outcome=null server-side;
// we translate it by omitting the outcome param from the request.
const UI_PENDING = 'pending';

const OUTCOME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any outcome' },
  { value: UI_PENDING, label: 'Pending (no capture)' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'no_action', label: 'No action' },
  { value: 'applied', label: 'Applied' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'auto_detected', label: 'Auto-detected' },
];

interface AdvisorListRow {
  recommendationId: string;
  productId: string;
  tenantId: string;
  productName: string | null;
  currentPlan: string | null;
  recommendedPlan: string | null;
  reasoning: string;
  mrrImpact: number | null;
  outcome: string | null;
  outcomeNote: string | null;
  createdAt: string;
  outcomeCapturedAt: string | null;
  operatorEmail: string | null;
}

interface ListResponse {
  data: AdvisorListRow[];
  total: number;
}

interface PortfolioProductListItem {
  productId: string;
  productName: string;
}

interface PortfolioResponse {
  data: PortfolioProductListItem[];
  total: number;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; rows: AdvisorListRow[]; total: number };

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatOutcomeLabel(outcome: string | null): string {
  if (!outcome) return '—';
  const opt = OUTCOME_OPTIONS.find((o) => o.value === outcome);
  return opt?.label ?? outcome;
}

function OutcomeBadge({ outcome }: { outcome: string | null }): React.ReactElement {
  const classMap: Record<string, string> = {
    won: 'bg-seafoam/15 text-seafoam',
    lost: 'bg-ironwake/15 text-ironwake',
    no_action: 'bg-deep-charcoal/10 text-deep-charcoal/70',
    applied: 'bg-secondary-blue/15 text-secondary-blue',
    dismissed: 'bg-accent-brass/15 text-accent-brass',
    auto_detected: 'bg-deep-charcoal/10 text-deep-charcoal/70',
  };
  if (!outcome) {
    return (
      <span
        data-testid="advisor-outcome-pending"
        className="inline-flex items-center rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs font-body text-deep-charcoal/70"
      >
        pending
      </span>
    );
  }
  const cls = classMap[outcome] ?? 'bg-deep-charcoal/10 text-deep-charcoal/70';
  return (
    <span
      data-testid={`advisor-outcome-${outcome}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${cls}`}
    >
      {formatOutcomeLabel(outcome)}
    </span>
  );
}

export default function PlanAdvisor(): React.ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlProductId = searchParams.get('productId') ?? '';
  const urlOutcome = searchParams.get('outcome') ?? '';
  const [productId, setProductId] = useState<string>(urlProductId);
  const [outcome, setOutcome] = useState<string>(urlOutcome);
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const [products, setProducts] = useState<PortfolioProductListItem[]>([]);

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  // Light-touch URL sync — mirror filter selections into the query string.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (productId) next.set('productId', productId);
        else next.delete('productId');
        if (outcome) next.set('outcome', outcome);
        else next.delete('outcome');
        return next;
      },
      { replace: true },
    );
  }, [productId, outcome, setSearchParams]);

  const loadRuns = useCallback(
    async (
      selectedProductId: string,
      selectedOutcome: string,
    ): Promise<void> => {
      setState({ kind: 'loading' });
      const params = new URLSearchParams();
      if (selectedProductId) params.set('productId', selectedProductId);
      // "pending" is a UI pseudo-value -> omit outcome from the request so
      // the BE returns all outcomes including null.
      if (selectedOutcome && selectedOutcome !== UI_PENDING) {
        params.set('outcome', selectedOutcome);
      }
      const qs = params.toString();
      const url = qs
        ? `${RECOMMENDATIONS_PATH}?${qs}`
        : RECOMMENDATIONS_PATH;
      try {
        const res = await apiClient.get<ListResponse>(url);
        const rows =
          selectedOutcome === UI_PENDING
            ? res.data.filter((r) => r.outcome === null)
            : res.data;
        setState({ kind: 'ready', rows, total: res.total });
      } catch (err) {
        if (err instanceof PermissionDeniedError) {
          setState({ kind: 'denied' });
          return;
        }
        const message =
          err instanceof Error
            ? err.message
            : 'Failed to load advisor recommendations';
        setState({ kind: 'error', message });
      }
    },
    [],
  );

  useEffect(() => {
    void loadRuns(productId, outcome);
  }, [productId, outcome, loadRuns]);

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .get<PortfolioResponse>(PORTFOLIO_PATH)
      .then((res) => {
        if (!cancelled) setProducts(res.data);
      })
      .catch(() => {
        // Non-fatal — product picker stays empty (operator can deep-link
        // by URL or super_admin can omit productId for the portfolio view).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleProductChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setProductId(event.target.value);
    },
    [],
  );

  const handleOutcomeChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setOutcome(event.target.value);
    },
    [],
  );

  const handleRowClick = useCallback(
    (row: AdvisorListRow) => {
      navigate(`/console/plan-advisor/${row.recommendationId}`);
    },
    [navigate],
  );

  const handleNewRecommendation = useCallback(() => {
    navigate('/console/plan-advisor/new');
  }, [navigate]);

  const columns: ColumnDef<AdvisorListRow>[] = useMemo(
    () => [
      {
        key: 'timestamp',
        header: 'Timestamp',
        render: (r) => formatTimestamp(r.createdAt),
        sortable: true,
        sortValue: (r) => new Date(r.createdAt),
      },
      {
        key: 'product',
        header: 'Product',
        render: (r) => r.productName ?? '—',
        sortable: true,
        sortValue: (r) => r.productName ?? '',
        searchValue: (r) => `${r.productName ?? ''} ${r.productId}`,
      },
      {
        key: 'currentPlan',
        header: 'Current Plan',
        // BE returns null at v0.1 per spec deviation #3.
        render: (r) => r.currentPlan ?? '—',
      },
      {
        key: 'recommendedPlan',
        header: 'Recommended Plan',
        render: (r) => r.recommendedPlan ?? '—',
        sortable: true,
        sortValue: (r) => r.recommendedPlan ?? '',
      },
      {
        key: 'outcome',
        header: 'Outcome',
        render: (r) => <OutcomeBadge outcome={r.outcome} />,
        sortable: true,
        sortValue: (r) => r.outcome ?? 'zzz_pending',
      },
      {
        key: 'operator',
        header: 'Operator',
        render: (r) => r.operatorEmail ?? '—',
      },
    ],
    [],
  );

  if (state.kind === 'denied') {
    return (
      <div
        id="main-content"
        data-testid="plan-advisor-page"
        className="flex flex-col gap-4"
      >
        <AccessDeniedPage
          resourceLabel="the plan advisor"
          backTo="/console/dashboard"
          backLabel="Back to dashboard"
        />
      </div>
    );
  }

  return (
    <div
      id="main-content"
      data-testid="plan-advisor-page"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <h1 className="font-heading text-2xl text-primary-navy">
          Plan Advisor
        </h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Product
            <select
              data-testid="plan-advisor-product-filter"
              value={productId}
              onChange={handleProductChange}
              className="rounded border border-deep-charcoal/20 bg-white p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.productId} value={p.productId}>
                  {p.productName}
                </option>
              ))}
              {/* Surface a URL-deeplinked productId that isn't in the
                  picker as a fallback option so the dropdown reflects
                  the active filter even before the picker loads. */}
              {productId &&
                !products.some((p) => p.productId === productId) && (
                  <option value={productId}>{productId}</option>
                )}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Outcome
            <select
              data-testid="plan-advisor-outcome-filter"
              value={outcome}
              onChange={handleOutcomeChange}
              className="rounded border border-deep-charcoal/20 bg-white p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              {OUTCOME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="plan-advisor-new-cta"
            onClick={handleNewRecommendation}
            className="inline-flex items-center rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth shadow-sm hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            New Recommendation
          </button>
        </div>
      </header>

      {state.kind === 'error' && (
        <div
          role="alert"
          data-testid="plan-advisor-error-banner"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Could not load advisor history.</p>
          <p className="mt-1">{state.message}</p>
          <button
            type="button"
            onClick={() => void loadRuns(productId, outcome)}
            className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Retry
          </button>
        </div>
      )}

      <DataTable<AdvisorListRow>
        columns={columns}
        rows={state.kind === 'ready' ? state.rows : []}
        pageSize={PAGE_SIZE}
        defaultSort={{ key: 'timestamp', direction: 'desc' }}
        searchableColumns={['product']}
        loading={state.kind === 'loading'}
        error={null}
        emptyState={
          <div
            data-testid="plan-advisor-empty-state"
            className="flex flex-col items-start gap-2 text-sm font-body text-deep-charcoal/80"
          >
            <p>No recommendations yet — run your first one.</p>
            <button
              type="button"
              data-testid="plan-advisor-empty-cta"
              onClick={handleNewRecommendation}
              className="rounded-md bg-primary-navy px-3 py-1.5 text-sm text-sailcloth shadow-sm hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              New Recommendation
            </button>
          </div>
        }
        onRowClick={handleRowClick}
        rowKey={(r) => r.recommendationId}
        ariaLabel="Plan advisor recommendations"
      />
    </div>
  );
}
