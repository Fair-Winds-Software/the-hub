// Authorized by HUB-1604 (E-FE-3 S4) — /console/products/:productId detail scaffold.
// Renders a product header (name + key + status badge) above a HUB-1602
// <TabbedDetailView> with five tabs: Overview / Plans / Pricing Model / Audit /
// Notifications. Tab content slots are placeholders at S4; sibling stories S5
// (Overview + inline edits), S6 (Plans), S7 (Audit), S8 (Notifications) fill them
// in. Pricing Model is link-only per decomposition D2 — single CTA linking to
// /console/products/:productId/pricing (HUB-1563 E-FE-5 owns the editor).
//
// Spec deviations (documented per ironclad-engineer):
// 1. API source: the spec named GET /api/v1/admin/products/:productId, which does
//    not exist as a flat endpoint. The portfolio aggregator
//    /api/v1/admin/portfolio/products (HUB-1700) already returns the header fields
//    (productName / status / tenantId / mrrCents / lastActiveAt). We fetch the
//    portfolio list and find by productId — bounded to v0.1 portfolio scale (5-10
//    rows per HUB-1700 §5). When the BE adds a single-product detail endpoint, a
//    single-call swap replaces the list filter without touching consumer code.
// 2. URL deep-link parsing: query param 'tab' is owned by <TabbedDetailView>; we
//    pass the configurable urlParam through but do not parse it here. Browser
//    back/forward and shareable links "just work" by virtue of the primitive.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TabbedDetailView, type TabDef } from '../components/TabbedDetailView';
import { apiClient } from '../lib/api';
import type { PortfolioProduct } from './Products';
import { OverviewTab } from './productDetailTabs/OverviewTab';
import { PlansTab } from './productDetailTabs/PlansTab';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE_PREFIX = 'Product';

interface PortfolioResponse {
  data: PortfolioProduct[];
  total: number;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not-found' }
  | { kind: 'ready'; product: PortfolioProduct };

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const isActive = status === 'active';
  return (
    <span
      data-testid="product-status-badge"
      className={
        isActive
          ? 'inline-flex items-center rounded-full bg-seafoam/15 px-2.5 py-0.5 text-xs font-body text-seafoam'
          : 'inline-flex items-center rounded-full bg-deep-charcoal/10 px-2.5 py-0.5 text-xs font-body text-deep-charcoal'
      }
    >
      {status}
    </span>
  );
}

function HeaderSkeleton(): React.ReactElement {
  return (
    <div data-testid="product-header-skeleton" className="flex flex-col gap-2">
      <div className="h-7 w-48 animate-pulse rounded bg-deep-charcoal/10" />
      <div className="h-4 w-32 animate-pulse rounded bg-deep-charcoal/10" />
    </div>
  );
}

function TabStripSkeleton(): React.ReactElement {
  return (
    <div
      data-testid="product-tabs-skeleton"
      className="flex gap-4 border-b border-deep-charcoal/15 pb-2"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-4 w-20 animate-pulse rounded bg-deep-charcoal/10"
        />
      ))}
    </div>
  );
}

function PricingModelLinkCta({ productId }: { productId: string }): React.ReactElement {
  return (
    <div className="flex flex-col items-start gap-2 p-4">
      <p className="font-body text-sm text-deep-charcoal/80">
        Pricing model configuration lives in its own editor (HUB-1563 / E-FE-5).
      </p>
      <Link
        to={`/console/products/${productId}/pricing`}
        data-testid="pricing-model-cta"
        className="inline-flex items-center rounded-md border border-primary-navy/20 bg-white px-3 py-1.5 text-sm font-body text-primary-navy shadow-sm hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        Edit pricing model
      </Link>
    </div>
  );
}

// Placeholder content for tabs whose sibling stories haven't landed yet. Replaced in
// S5/S6/S7/S8 with the real components — the tab definitions in this file get
// re-wired then. Spec contract for S4: the tabs RENDER and DEEP-LINK; their content
// is sibling-owned.
function PlaceholderTab({ label, story }: { label: string; story: string }): React.ReactElement {
  return (
    <div className="p-4 font-body text-sm text-deep-charcoal/80">
      {label} tab content lands in {story}.
    </div>
  );
}

export default function ProductDetail(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    const prev = document.title;
    document.title = `${PAGE_TITLE_PREFIX} | HUB Console`;
    return () => {
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    if (state.kind === 'ready') {
      document.title = `${state.product.productName} | HUB Console`;
    }
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void apiClient
      .get<PortfolioResponse>(PORTFOLIO_PATH)
      .then((res) => {
        if (cancelled) return;
        const match = res.data.find((p) => p.productId === productId);
        if (!match) {
          setState({ kind: 'not-found' });
        } else {
          setState({ kind: 'ready', product: match });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load product';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const handleProductChange = useCallback((next: PortfolioProduct) => {
    setState({ kind: 'ready', product: next });
  }, []);

  // The HUB-1605 OverviewTab needs the loaded product. We compute the tab
  // definition only when the product has resolved so the placeholder path
  // is never asked to render OverviewTab with no data.
  const readyProduct = state.kind === 'ready' ? state.product : null;
  const tabs: TabDef[] = useMemo(
    () => [
      {
        id: 'overview',
        label: 'Overview',
        content: readyProduct ? (
          <OverviewTab
            product={readyProduct}
            onProductChange={handleProductChange}
          />
        ) : (
          <PlaceholderTab label="Overview" story="HUB-1605 (S5)" />
        ),
      },
      {
        id: 'plans',
        label: 'Plans',
        content: <PlansTab productId={productId} />,
      },
      {
        id: 'pricing',
        label: 'Pricing Model',
        content: <PricingModelLinkCta productId={productId} />,
      },
      {
        id: 'audit',
        label: 'Audit',
        content: <PlaceholderTab label="Audit" story="HUB-1607 (S7)" />,
      },
      {
        id: 'notifications',
        label: 'Notifications',
        content: <PlaceholderTab label="Notifications" story="HUB-1608 (S8)" />,
      },
    ],
    [productId, readyProduct, handleProductChange],
  );

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="product-detail-page"
        className="flex flex-col gap-4"
      >
        <HeaderSkeleton />
        <TabStripSkeleton />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        data-testid="product-detail-page"
        className="flex flex-col gap-4"
      >
        <div
          role="alert"
          data-testid="product-detail-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Could not load this product.</p>
          <p className="mt-1">{state.message}</p>
          <Link
            to="/console/products"
            className="mt-2 inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Back to products
          </Link>
        </div>
      </div>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <div
        id="main-content"
        data-testid="product-detail-page"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="product-not-found"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal"
        >
          <p className="font-medium">Product not found.</p>
          <p className="mt-1">
            We couldn&apos;t find a product with id <code>{productId}</code> in
            your portfolio.
          </p>
          <Link
            to="/console/products"
            className="mt-2 inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Back to products
          </Link>
        </div>
      </div>
    );
  }

  const product = state.product;
  return (
    <div
      id="main-content"
      data-testid="product-detail-page"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1
            data-testid="product-detail-name"
            className="font-heading text-2xl text-primary-navy"
          >
            {product.productName}
          </h1>
          <StatusBadge status={product.status} />
        </div>
        <p
          data-testid="product-detail-key"
          className="font-body text-sm text-deep-charcoal/70"
        >
          ID: <code>{product.productId}</code>
        </p>
      </header>
      <TabbedDetailView
        tabs={tabs}
        defaultTab="overview"
        ariaLabel="Product detail tabs"
      />
    </div>
  );
}
