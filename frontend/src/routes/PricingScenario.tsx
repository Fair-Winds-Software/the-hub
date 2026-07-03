// Authorized by HUB-1669 (E-FE-11 S1) — Pricing Scenario Simulator shell
// at /console/pricing-scenario. Product picker + empty state.
// Authorized by HUB-1670 (E-FE-11 S2) — Calculator inputs + 300ms
// debounced recompute + AbortController for in-flight cancellation +
// loading + BE-error inline surface (404 PRICING-001 gets the
// "no pricing model" resolution guidance).
//
// Picker sourced from /api/v1/admin/portfolio/products (same lookup the
// SystemHealth + CustomerHealth pages use). RBAC is server-authoritative
// via HUB-1700's tenant-scoped filter — product_admin already gets a
// scoped list, so this page doesn't need a second client-side filter.
//
// Endpoint path deviation (per HUB-1598): the story spec named
// POST /api/v1/admin/analytics/pricing-scenario. The actual live
// endpoint (documented in analyticsRoutes.ts header) is
// POST /api/v1/analytics/pricing-scenario — no /admin/ segment, same
// preHandler operator-JWT auth. Matching the live path.
//
// Slider ranges are UI-clamped tighter than the BE contract: price
// change -50 to +50 (BE allows -100..1000), churn 0 to 30 (BE allows
// 0..100). The tightening matches the operator-realistic band from
// FR-003; the BE still validates.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../lib/api';
import { ApiError, PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import { PricingScenarioInputs } from './pricingScenario/PricingScenarioInputs';
import { PricingScenarioResults } from './pricingScenario/PricingScenarioResults';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const SCENARIO_PATH = '/api/v1/analytics/pricing-scenario';
const PAGE_TITLE = 'Pricing Scenario | HUB Console';
const DEBOUNCE_MS = 300;

export interface PortfolioProduct {
  productId: string;
  productName: string;
}

export interface ScenarioBaseline {
  snapshotAt: string;
  productId: string;
  revenueLast30dCents: number;
  costLast30dCents: number;
  subscriptionCount: number;
  elasticityCoefficient: number;
  marginPct: number | null;
}

export interface ScenarioProjection {
  revenueCents: number;
  costCents: number;
  marginPct: number | null;
  subscriptionCount: number;
}

export interface ScenarioDelta {
  revenueCents: number;
  costCents: number;
  marginPctPoints: number | null;
  subscriptionCount: number;
}

export interface ScenarioResponse {
  baseline: ScenarioBaseline;
  scenario: ScenarioProjection;
  delta: ScenarioDelta;
  modelType: 'constant_elasticity';
  disclaimer: string;
  baselineSnapshotAt: string;
  generatedAt: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; products: PortfolioProduct[] };

type ComputeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'no-pricing-model' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; payload: ScenarioResponse };

export default function PricingScenario(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [priceChangePercent, setPriceChangePercent] = useState<number>(0);
  const [churnAssumptionPercent, setChurnAssumptionPercent] = useState<number>(0);
  const [compute, setCompute] = useState<ComputeState>({ kind: 'idle' });
  const inFlightRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Reset compute state + input defaults when the product changes so the
  // operator doesn't see a stale result from a previous product while
  // the new one is fetching.
  useEffect(() => {
    setPriceChangePercent(0);
    setChurnAssumptionPercent(0);
    setCompute({ kind: 'idle' });
  }, [selectedProductId]);

  // Debounced compute effect: (product, price, churn) → POST scenario.
  // AbortController cancels any in-flight request when inputs change
  // again — prevents an older-fetch race from overwriting newer results.
  useEffect(() => {
    if (!selectedProductId) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (inFlightRef.current) inFlightRef.current.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;
      setCompute({ kind: 'loading' });
      apiClient
        .post<ScenarioResponse>(
          SCENARIO_PATH,
          {
            product_id: selectedProductId,
            price_change_percent: priceChangePercent,
            churn_assumption_percent: churnAssumptionPercent,
          },
          { signal: controller.signal },
        )
        .then((payload) => {
          if (controller.signal.aborted) return;
          setCompute({ kind: 'ready', payload });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && err.status === 404) {
            setCompute({ kind: 'no-pricing-model' });
            return;
          }
          const message =
            err instanceof Error ? err.message : 'Failed to compute scenario';
          setCompute({ kind: 'error', message });
        });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [selectedProductId, priceChangePercent, churnAssumptionPercent]);

  const handleInputsChange = useCallback(
    (next: { priceChangePercent: number; churnAssumptionPercent: number }) => {
      setPriceChangePercent(next.priceChangePercent);
      setChurnAssumptionPercent(next.churnAssumptionPercent);
    },
    [],
  );

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
        <div
          data-testid="pricing-scenario-picked"
          className="grid grid-cols-1 gap-4 md:grid-cols-[20rem_1fr]"
        >
          <PricingScenarioInputs
            priceChangePercent={priceChangePercent}
            churnAssumptionPercent={churnAssumptionPercent}
            onChange={handleInputsChange}
            disabled={compute.kind === 'loading'}
          />

          <div className="flex flex-col gap-3">
            {compute.kind === 'loading' && (
              <div
                data-testid="pricing-scenario-compute-loading"
                className="h-40 animate-pulse rounded-md bg-deep-charcoal/5"
              />
            )}
            {compute.kind === 'no-pricing-model' && (
              <div
                role="alert"
                data-testid="pricing-scenario-no-pricing-model"
                className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
              >
                <p className="font-medium">
                  This product has no active pricing model.
                </p>
                <p className="mt-1">
                  Set up a pricing model in Products → Pricing before running a
                  what-if scenario against it. The advisor + billing surfaces
                  depend on this too.
                </p>
              </div>
            )}
            {compute.kind === 'error' && (
              <div
                role="alert"
                data-testid="pricing-scenario-compute-error"
                className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
              >
                <p className="font-medium">Couldn’t compute the scenario.</p>
                <p className="mt-1">{compute.message}</p>
              </div>
            )}
            {compute.kind === 'ready' && (
              <div data-testid="pricing-scenario-compute-ready">
                <PricingScenarioResults payload={compute.payload} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
