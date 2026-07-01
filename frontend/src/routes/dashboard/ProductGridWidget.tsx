// Authorized by HUB-1646 (E-FE-2 S3) — Portfolio product grid rendered in
// the dashboard shell's product-grid region. Fetches the operator's product
// list and renders a 3-column responsive card grid (2 columns at md, 1 at
// mobile). Each card is a keyboard-navigable anchor to the HUB-1557
// products detail view.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Endpoint: spec required a two-tier fan-out
//      (GET /admin/console/tenants → per-tenant GET /admin/tenants/:tid/products).
//      HUB-1700 (E-BE-1 S23) shipped GET /api/v1/admin/portfolio/products as
//      a single aggregation endpoint keyed off products.tenant_id, sized for
//      v0.1 portfolio scale (5–10 products; no Redis cache per HUB-1700
//      rationale). The `/admin/console/tenants` route also turned out to
//      require a mandatory `product_id` query param, which makes it unusable
//      as a portfolio-wide tenant lister. This widget consumes the flat
//      HUB-1700 endpoint instead — RBAC scoping is server-authoritative
//      (product_admin gets their tenant's rows filtered by
//      operatorTenantId; super_admin gets everything). AC#1's client-side
//      scope filter therefore reduces to a pass-through (S6/HUB-1649 owns
//      the RBAC-boundary test).
//
//   2. CRs / Bugs counts: S4 (HUB-1647) owns the Jira integration that
//      fills those slots. S3 reserves the layout + renders a skeleton
//      pulse for each slot; the S4 story swaps in the real numbers
//      without changing the card layout.
//
//   3. 100-card fan-out cap (spec §9 risk mitigation): moot with the
//      single-endpoint aggregation. The BE limit is 200; we request 100
//      to match the spec cap.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../lib/api';

const PORTFOLIO_PRODUCTS_PATH = '/api/v1/admin/portfolio/products?limit=100';

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
  tenantName: string;
  status: string;
  mrrCents: number;
  createdAt: string;
  lastActiveAt: string | null;
}

interface PortfolioResponse {
  data: PortfolioProduct[];
  total: number;
}

type GridState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; products: PortfolioProduct[] };

function formatDollarsFromCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

// Triple-encoded status badge — color + icon + text label. Unknown status
// values render as neutral so the badge never breaks on a BE enum expansion.
type StatusVerdict = 'success' | 'warning' | 'error' | 'neutral';

function verdictFor(status: string): StatusVerdict {
  const s = status.toLowerCase();
  if (s === 'active') return 'success';
  if (s === 'pending' || s === 'trial' || s === 'paused') return 'warning';
  if (s === 'suspended' || s === 'inactive' || s === 'churned') return 'error';
  return 'neutral';
}

const VERDICT_CLASSES: Record<StatusVerdict, string> = {
  success: 'border-seafoam/40 bg-seafoam/10 text-seafoam',
  warning: 'border-accent-brass/40 bg-accent-brass/10 text-accent-brass',
  error: 'border-ironwake/40 bg-ironwake/10 text-ironwake',
  neutral: 'border-deep-charcoal/20 bg-deep-charcoal/5 text-deep-charcoal/70',
};

function StatusIcon({
  verdict,
}: {
  verdict: StatusVerdict;
}): React.ReactElement {
  const common = {
    width: 12,
    height: 12,
    viewBox: '0 0 12 12',
    'aria-hidden': true as const,
  };
  switch (verdict) {
    case 'success':
      return (
        <svg {...common}>
          <path
            d="M2.5 6.5L4.75 8.75L9.5 3.75"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path
            d="M6 1.5L11 10.5H1L6 1.5Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case 'error':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <line x1="4" y1="4" x2="8" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="8" y1="4" x2="4" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'neutral':
    default:
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="1.6" fill="currentColor" />
        </svg>
      );
  }
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const verdict = verdictFor(status);
  const displayText = status || 'unknown';
  return (
    <span
      data-testid={`product-card-status-${verdict}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-body ${VERDICT_CLASSES[verdict]}`}
    >
      <StatusIcon verdict={verdict} />
      <span>{displayText}</span>
    </span>
  );
}

function TicketCountSkeleton({
  testId,
}: {
  testId: string;
}): React.ReactElement {
  // S4 (HUB-1647) swaps this pulse for the real count once the Jira
  // integration lands. Rendered as a fixed-width dash so the card layout
  // doesn't shift when the number arrives (CLS < 0.05 per S7).
  return (
    <span
      data-testid={testId}
      className="inline-block h-4 w-6 animate-pulse rounded bg-deep-charcoal/10"
      aria-hidden="true"
    />
  );
}

function ProductCard({
  product,
}: {
  product: PortfolioProduct;
}): React.ReactElement {
  const ariaLabel = `${product.productName}, status ${product.status || 'unknown'}, MRR ${formatDollarsFromCents(product.mrrCents)}`;
  return (
    <Link
      to={`/console/products/${product.productId}`}
      data-testid={`product-card-${product.productId}`}
      aria-label={ariaLabel}
      className="flex flex-col gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 no-underline transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent-brass"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3
            data-testid="product-card-name"
            className="font-heading text-base text-primary-navy underline decoration-primary-navy/40 underline-offset-2"
          >
            {product.productName}
          </h3>
          <p className="mt-0.5 font-body text-xs text-deep-charcoal/60">
            {product.tenantName}
          </p>
        </div>
        <StatusBadge status={product.status} />
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          data-testid="product-card-mrr"
          className="font-heading text-xl text-primary-navy"
        >
          {formatDollarsFromCents(product.mrrCents)}
        </span>
        <span className="font-body text-xs text-deep-charcoal/60">MRR</span>
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs font-body text-deep-charcoal/70">
        <span className="inline-flex items-center gap-1">
          Open CRs:{' '}
          <TicketCountSkeleton
            testId={`product-card-cr-count-skeleton-${product.productId}`}
          />
        </span>
        <span className="inline-flex items-center gap-1">
          Open Bugs:{' '}
          <TicketCountSkeleton
            testId={`product-card-bug-count-skeleton-${product.productId}`}
          />
        </span>
      </div>
    </Link>
  );
}

export function ProductGridWidget(): React.ReactElement {
  const [state, setState] = useState<GridState>({ kind: 'loading' });

  const loadProducts = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res =
        await apiClient.get<PortfolioResponse>(PORTFOLIO_PRODUCTS_PATH);
      setState({ kind: 'ready', products: res.data });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load products';
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  if (state.kind === 'loading') {
    return (
      <div
        data-testid="product-grid-widget-loading"
        className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            data-testid="product-card-skeleton"
            className="h-[9rem] animate-pulse rounded-md border border-deep-charcoal/10 bg-deep-charcoal/5"
          />
        ))}
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        data-testid="product-grid-widget-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load your products.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="product-grid-widget-retry"
          onClick={() => void loadProducts()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.products.length === 0) {
    return (
      <div
        data-testid="product-grid-widget-empty"
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-6 text-sm font-body text-deep-charcoal/70"
      >
        No products in scope yet. Ask Sammy for access, or create your first
        product from the Products page.
      </div>
    );
  }

  return (
    <div
      data-testid="product-grid-widget"
      className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3"
    >
      {state.products.map((p) => (
        <ProductCard key={p.productId} product={p} />
      ))}
    </div>
  );
}
