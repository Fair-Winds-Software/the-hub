// Authorized by HUB-1631 (E-FE-10 S2) — /console/sdk-versions scaffold. Renders
// the SDK-name filter dropdown above three vertical content slots that S3
// (distribution chart), S4 (product breakdown), and S5 (deprecation impact
// widget) fill in. URL ?sdkName= sync is light-touch (deep-link recoverable
// without the full HUB-1616 useAuditUrlSync ceremony).
//
// RBAC: this route is wired in App.tsx with GuardedRoute(requiredRole=
// 'super_admin'). product_admin URL-hacks redirect to /console/dashboard
// with the standard permission toast — that path is owned by HUB-1574
// RBACRoute and tested in HUB-1578.
//
// Spec notes:
// 1. SDK name list: the BE accepts any identifier matching ^[a-z][a-z0-9-]*$;
//    there's no list-of-SDKs endpoint. We hardcode the spec-named options
//    (hub-sdk / synapz-sdk / launchkit-sdk) per the spec's enumeration. New
//    SDK identifiers can be deep-linked via ?sdkName=<key> and the page will
//    honor the URL even if not in the dropdown.
// 2. The page itself is structural at S2 — content slots stay placeholder
//    until S3/S4/S5 land. The data fetch is therefore a defensive 'is there
//    ANY SDK data at all?' probe used to drive the empty-state copy per AC.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { DistributionChartSection } from './sdkVersions/DistributionChartSection';

const DISTRIBUTION_PATH = '/api/v1/admin/sdk-versions/distribution';
const PAGE_TITLE = 'SDK Versions | HUB Console';

export type SdkName = string;

const KNOWN_SDK_OPTIONS: Array<{ value: SdkName; label: string }> = [
  { value: 'hub-sdk', label: 'HUB SDK' },
  { value: 'synapz-sdk', label: 'Synapz SDK' },
  { value: 'launchkit-sdk', label: 'LaunchKit SDK' },
];

const DEFAULT_SDK: SdkName = 'hub-sdk';

interface DistributionRow {
  version: string;
  productCount: number;
  products?: string[];
}

interface DistributionResponse {
  sdkName: string;
  distribution: DistributionRow[];
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'ready'; data: DistributionResponse };

export default function SdkVersions(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSdkName = searchParams.get('sdkName');
  const [sdkName, setSdkName] = useState<SdkName>(urlSdkName ?? DEFAULT_SDK);
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  // Light-touch URL sync: mirror the dropdown selection into ?sdkName=.
  useEffect(() => {
    if (searchParams.get('sdkName') === sdkName) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('sdkName', sdkName);
        return next;
      },
      { replace: true },
    );
  }, [sdkName, searchParams, setSearchParams]);

  const loadDistribution = useCallback(
    async (selected: SdkName): Promise<void> => {
      setState({ kind: 'loading' });
      try {
        const res = await apiClient.get<DistributionResponse>(
          `${DISTRIBUTION_PATH}?sdkName=${encodeURIComponent(selected)}`,
        );
        if (!res.distribution || res.distribution.length === 0) {
          setState({ kind: 'empty' });
          return;
        }
        setState({ kind: 'ready', data: res });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load SDK distribution';
        setState({ kind: 'error', message });
      }
    },
    [],
  );

  useEffect(() => {
    void loadDistribution(sdkName);
  }, [sdkName, loadDistribution]);

  const handleSdkChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setSdkName(event.target.value);
    },
    [],
  );

  return (
    <div
      id="main-content"
      data-testid="sdk-versions-page"
      className="flex flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl text-primary-navy">SDK Versions</h1>
        <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
          SDK
          <select
            data-testid="sdk-versions-filter"
            value={sdkName}
            onChange={handleSdkChange}
            className="rounded border border-deep-charcoal/20 bg-white p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {KNOWN_SDK_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
            {/* If the URL specified an unknown sdkName, surface it as a
                disabled option so the selected value matches an <option>. */}
            {!KNOWN_SDK_OPTIONS.some((o) => o.value === sdkName) && (
              <option value={sdkName}>{sdkName}</option>
            )}
          </select>
        </label>
      </header>

      {state.kind === 'error' && (
        <div
          role="alert"
          data-testid="sdk-versions-error-banner"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Could not load SDK distribution.</p>
          <p className="mt-1">{state.message}</p>
          <button
            type="button"
            onClick={() => void loadDistribution(sdkName)}
            className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === 'loading' && (
        <div
          data-testid="sdk-versions-loading"
          className="flex flex-col gap-3"
        >
          <div className="h-48 animate-pulse rounded-md bg-deep-charcoal/10" />
          <div className="h-32 animate-pulse rounded-md bg-deep-charcoal/10" />
          <div className="h-24 animate-pulse rounded-md bg-deep-charcoal/10" />
        </div>
      )}

      {state.kind === 'empty' && (
        <div
          data-testid="sdk-versions-empty-state"
          className="flex flex-col items-start gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-6 text-sm font-body text-deep-charcoal/80"
        >
          <p>
            No products have reported SDK versions yet — SDK Client phones home
            on first request.
          </p>
          <a
            href="https://docs.maverick.launch/sdk"
            data-testid="sdk-versions-docs-link"
            className="underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
            target="_blank"
            rel="noopener noreferrer"
          >
            SDK docs
          </a>
        </div>
      )}

      {state.kind === 'ready' && (
        <div className="flex flex-col gap-4">
          <DistributionChartSection
            sdkName={state.data.sdkName}
            rows={state.data.distribution}
          />
          <section
            aria-labelledby="sdk-products-section-heading"
            data-testid="sdk-versions-section-products"
            className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
          >
            <h2
              id="sdk-products-section-heading"
              className="font-heading text-lg text-primary-navy mb-2"
            >
              Product Breakdown
            </h2>
            <p className="font-body text-sm text-deep-charcoal/70">
              Per-product table + stale detection lands in HUB-1633 (S4).
            </p>
          </section>
          <section
            aria-labelledby="sdk-impact-section-heading"
            data-testid="sdk-versions-section-impact"
            className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
          >
            <h2
              id="sdk-impact-section-heading"
              className="font-heading text-lg text-primary-navy mb-2"
            >
              Deprecation Impact
            </h2>
            <p className="font-body text-sm text-deep-charcoal/70">
              Deprecation impact widget lands in HUB-1634 (S5).
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
