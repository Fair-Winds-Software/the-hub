// Authorized by HUB-1639 (E-FE-4 S3) — New Recommendation flow. Operator picks
// a product, the FE checks for a recent advisor run on that product (within
// 7 days), warns if so, then POSTs to the run endpoint. On success navigates
// to the S4 result view.
// Authorized by HUB-1642 (E-FE-4 S6) — RBAC scope wiring. PermissionDeniedError
// from the POST /run path now surfaces as an explicit "out of scope" inline
// banner instead of a raw err.message. Server is authoritative; the FE picker
// is sourced from /portfolio/products which is already scope-filtered server-
// side, so a 403 here only fires on a URL-hack / state-tamper attempt.
//
// Spec deviations (documented per ironclad-engineer):
// 1. Run endpoint: spec named POST /api/v1/admin/plan-advisor/run with
//    {productId, tenantId} in the body. The canonical HUB BE surface is
//    POST /api/v1/admin/advisor/:productId/:tenantId/run (HUB-1148; path
//    params). Same logical contract. Requires tenantId, sourced from the
//    PortfolioProduct.tenantId we already fetch for the picker.
// 2. Recency check: spec named GET /runs?productId=&since=<7d>. Real
//    surface is /admin/advisor/recommendations which doesn't accept a
//    `since` param. We fetch limit=1 + filter the createdAt client-side
//    per the spec's "filter client-side if BE doesn't support since".
// 3. Endpoint base for recency: matches HUB-1638's list endpoint
//    (/admin/advisor/recommendations) so the FE uses one set of advisor
//    paths consistently.
//
// Click count per AC#8: Picker click (1) -> Run / Run anyway (1) -> navigate
// (1). With the S2 'New Recommendation' button click (1) that opens this
// flow, the total reaches the AC-E1 4-click contract.
import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const RECOMMENDATIONS_PATH = '/api/v1/admin/advisor/recommendations';
const PAGE_TITLE = 'New Recommendation | HUB Console';
const RECENT_THRESHOLD_DAYS = 7;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

interface PortfolioProductListItem {
  productId: string;
  productName: string;
  tenantId: string;
}

interface PortfolioResponse {
  data: PortfolioProductListItem[];
  total: number;
}

interface AdvisorListRow {
  recommendationId: string;
  createdAt: string;
}

interface ListResponse {
  data: AdvisorListRow[];
  total: number;
}

interface RunResponse {
  id: string;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'denied'; productLabel: string };

// HUB-1642 AC#3 — explicit out-of-scope copy. Surfaces inline (rather than a
// full-page AccessDeniedPage) because the picker stays visible so the operator
// can select a different in-scope product without losing context.
const SCOPE_DENIAL_COPY =
  'You don’t have access to this product. Pick a product in your scope, or ask Sammy to grant access.';

function runEndpoint(productId: string, tenantId: string): string {
  return `/api/v1/admin/advisor/${productId}/${tenantId}/run`;
}

function recencyEndpoint(productId: string): string {
  const params = new URLSearchParams({ productId, limit: '1' });
  return `${RECOMMENDATIONS_PATH}?${params.toString()}`;
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return Infinity;
  return (Date.now() - then) / MILLIS_PER_DAY;
}

export default function NewRecommendationFlow(): React.ReactElement {
  const navigate = useNavigate();
  const [products, setProducts] = useState<PortfolioProductListItem[]>([]);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [recentRun, setRecentRun] = useState<AdvisorListRow | null>(null);
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });
  const productPickerId = useId();
  const warningId = useId();

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .get<PortfolioResponse>(PORTFOLIO_PATH)
      .then((res) => {
        if (cancelled) return;
        setProducts(res.data);
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load products';
        setProductsError(message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Recency check fires whenever the selection changes. Failure of the
  // recency check is non-fatal — the operator can still run; we just won't
  // surface the warning.
  useEffect(() => {
    if (!selectedProductId) {
      setRecentRun(null);
      return;
    }
    let cancelled = false;
    void apiClient
      .get<ListResponse>(recencyEndpoint(selectedProductId))
      .then((res) => {
        if (cancelled) return;
        const latest = res.data[0];
        if (latest && daysSince(latest.createdAt) <= RECENT_THRESHOLD_DAYS) {
          setRecentRun(latest);
        } else {
          setRecentRun(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setRecentRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProductId]);

  const selectedProduct = products.find(
    (p) => p.productId === selectedProductId,
  );

  const handleProductChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedProductId(event.target.value);
      setSubmit({ kind: 'idle' });
    },
    [],
  );

  const runAdvisor = useCallback(async (): Promise<void> => {
    if (!selectedProduct) return;
    setSubmit({ kind: 'submitting' });
    try {
      const res = await apiClient.post<RunResponse>(
        runEndpoint(selectedProduct.productId, selectedProduct.tenantId),
      );
      navigate(`/console/plan-advisor/${res.id}`);
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setSubmit({
          kind: 'denied',
          productLabel: selectedProduct.productName,
        });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Failed to run advisor';
      setSubmit({ kind: 'error', message });
    }
  }, [selectedProduct, navigate]);

  const handleCancelWarning = useCallback(() => {
    // Per spec AC#9 the warning is NOT remembered — cancel just clears the
    // selection so the operator sees the picker again with a fresh state.
    setSelectedProductId('');
    setRecentRun(null);
    setSubmit({ kind: 'idle' });
  }, []);

  const canRunDirect =
    selectedProduct !== undefined &&
    recentRun === null &&
    submit.kind !== 'submitting' &&
    submit.kind !== 'denied';

  return (
    <div
      id="main-content"
      data-testid="new-recommendation-page"
      className="flex flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl text-primary-navy">
          New Recommendation
        </h1>
        <Link
          to="/console/plan-advisor"
          data-testid="new-recommendation-cancel-link"
          className="font-body text-sm text-primary-navy underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Back to Plan Advisor
        </Link>
      </header>

      {productsError !== null && (
        <div
          role="alert"
          data-testid="new-recommendation-products-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          Could not load products: {productsError}
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4">
        <label
          htmlFor={productPickerId}
          className="font-body text-sm text-deep-charcoal/80"
        >
          Product
        </label>
        <select
          id={productPickerId}
          data-testid="new-recommendation-product-picker"
          value={selectedProductId}
          onChange={handleProductChange}
          className="rounded border border-deep-charcoal/20 bg-white p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          <option value="">Select a product…</option>
          {products.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.productName}
            </option>
          ))}
        </select>
      </div>

      {recentRun !== null && (
        <div
          role="alert"
          id={warningId}
          data-testid="new-recommendation-rerun-warning"
          className="rounded-md border border-accent-brass/40 bg-accent-brass/5 p-3 text-sm font-body text-accent-brass"
        >
          <p>
            Recent advisor run exists (
            <strong>
              {new Date(recentRun.createdAt).toLocaleString()}
            </strong>
            ) — recommendation may not have changed. Run anyway?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="new-recommendation-run-anyway"
              onClick={() => void runAdvisor()}
              disabled={submit.kind === 'submitting'}
              aria-describedby={warningId}
              className="rounded-md bg-accent-brass px-3 py-1.5 text-sm font-body text-sailcloth shadow-sm hover:bg-accent-brass/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Run anyway
            </button>
            <button
              type="button"
              data-testid="new-recommendation-cancel-warning"
              onClick={handleCancelWarning}
              className="rounded-md border border-accent-brass/40 px-3 py-1.5 text-sm font-body text-accent-brass hover:bg-accent-brass/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {submit.kind === 'error' && (
        <div
          role="alert"
          data-testid="new-recommendation-submit-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          {submit.message}
        </div>
      )}

      {submit.kind === 'denied' && (
        <div
          role="alert"
          data-testid="new-recommendation-scope-denied"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          <p className="font-medium">
            Access denied for{' '}
            <span data-testid="new-recommendation-scope-denied-product">
              {submit.productLabel}
            </span>
            .
          </p>
          <p className="mt-1">{SCOPE_DENIAL_COPY}</p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="new-recommendation-run-button"
          onClick={() => void runAdvisor()}
          disabled={!canRunDirect}
          className="inline-flex items-center rounded-md bg-primary-navy px-4 py-2 text-sm font-body text-sailcloth shadow-sm hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          {submit.kind === 'submitting' ? 'Running advisor…' : 'Run Advisor'}
        </button>
        {submit.kind === 'submitting' && (
          <span
            data-testid="new-recommendation-submitting"
            className="text-sm font-body text-deep-charcoal/70"
          >
            Advisor compute may take 1–3 seconds.
          </span>
        )}
      </div>
    </div>
  );
}
