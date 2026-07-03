// Authorized by HUB-1669 (E-FE-11 S1) — Pricing Scenario Simulator shell
// at /console/pricing-scenario. Product picker + empty state; the
// calculator inputs, recompute, results table, caveat banner, and reset
// button ship in HUB-1670 (S2) / HUB-1671 (S3) / HUB-1672 (S4).
//
// Picker sourced from /api/v1/admin/portfolio/products (same lookup the
// SystemHealth + CustomerHealth pages use). RBAC is server-authoritative
// via HUB-1700's tenant-scoped filter — product_admin already gets a
// scoped list, so this page doesn't need a second client-side filter.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Pricing Scenario | HUB Console';

export interface PortfolioProduct {
  productId: string;
  productName: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; products: PortfolioProduct[] };

export default function PricingScenario(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [selectedProductId, setSelectedProductId] = useState<string>('');

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const loadProducts = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await apiClient.get<{ data: PortfolioProduct[] }>(
        PORTFOLIO_PATH,
      );
      setState({ kind: 'ready', products: res.data });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
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
        id="main-content"
        data-testid="pricing-scenario-page-loading"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="pricing-scenario-skeleton"
          className="h-64 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }
  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="Pricing Scenario"
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
        data-testid="pricing-scenario-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load Pricing Scenario.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="pricing-scenario-retry"
          onClick={() => void loadProducts()}
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
      data-testid="pricing-scenario-page"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">
          Pricing Scenario Simulator
        </h1>
        <p className="text-xs font-body text-deep-charcoal/70">
          Single-product what-if. Pick a product and adjust the assumptions to
          see a projected impact vs the last-30-day baseline.
        </p>
      </header>

      <div className="flex flex-col gap-2 md:flex-row md:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="pricing-scenario-product"
            className="text-xs font-body text-deep-charcoal/70"
          >
            Product
          </label>
          <select
            id="pricing-scenario-product"
            data-testid="pricing-scenario-product"
            value={selectedProductId}
            onChange={(e) => setSelectedProductId(e.target.value)}
            className="rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            <option value="">Pick a product…</option>
            {state.products.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.productName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {selectedProductId === '' ? (
        <div
          data-testid="pricing-scenario-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          Pick a product to start.
        </div>
      ) : (
        // The full calculator (S2 inputs + S3 results + S4 caveat/reset)
        // ships in subsequent stories; this placeholder makes the shell
        // + picker + empty state contract verifiable now.
        <div
          data-testid="pricing-scenario-picked"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          Calculator inputs land in HUB-1670 (S2); results table in
          HUB-1671 (S3); caveat + reset in HUB-1672 (S4).
        </div>
      )}
    </div>
  );
}
