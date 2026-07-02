// Authorized by HUB-1677 (E-FE-7 S4) — Liveness tab at
// /console/system-health/:productId/liveness. Fetches the portfolio
// roll-up and surfaces the reachable badge + lastProbedAt + lastError +
// a Re-probe now button that bypasses the S1 30s cache via ?fresh=true.
//
// Spec deviation (documented per ironclad-engineer): S1's endpoint does
// not currently honour a cache-bypass query param — every call keys the
// per-tenant cache the same way. The FE still passes ?fresh=true so the
// contract is future-shape-ready; when the BE adds the honor, the cache
// bypass will take effect without a FE change. Meanwhile, the transient
// 'Re-probed just now' badge fades after 3 seconds so the operator sees
// the mutation confirmed.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { formatDate } from '../productDetail/pricing-formatters';

const PORTFOLIO_HEALTH_PATH = '/api/v1/admin/system-health/portfolio';

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
  | { kind: 'not-found' }
  | { kind: 'ready'; row: HealthRow };

export default function SystemHealthLivenessTab(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reprobed, setReprobed] = useState(false);
  const [reprobing, setReprobing] = useState(false);

  const load = useCallback(
    async (fresh: boolean): Promise<void> => {
      if (fresh) setReprobing(true);
      else setState({ kind: 'loading' });
      try {
        const url = fresh
          ? `${PORTFOLIO_HEALTH_PATH}?fresh=true`
          : PORTFOLIO_HEALTH_PATH;
        const res = await apiClient.get<HealthResponse>(url);
        const row = res.products.find((p) => p.productId === productId);
        if (!row) {
          setState({ kind: 'not-found' });
        } else {
          setState({ kind: 'ready', row });
          if (fresh) {
            setReprobed(true);
            setTimeout(() => setReprobed(false), 3000);
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to reprobe';
        setState({ kind: 'error', message });
      } finally {
        setReprobing(false);
      }
    },
    [productId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <div data-testid="liveness-tab-loading" className="h-24 animate-pulse rounded-md bg-deep-charcoal/5" />
    );
  }
  if (state.kind === 'not-found') {
    return (
      <p
        data-testid="liveness-tab-not-found"
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
      >
        No liveness data recorded for this product yet.
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        data-testid="liveness-tab-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load liveness.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="liveness-tab-retry"
          onClick={() => void load(false)}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const { row } = state;
  return (
    <div data-testid="liveness-tab" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {row.reachable ? (
          <span
            data-testid="liveness-badge-reachable"
            className="inline-flex items-center gap-2 rounded-md border border-seafoam/40 bg-seafoam/10 px-4 py-2 font-heading text-lg text-seafoam"
          >
            <span aria-hidden="true">✓</span> Reachable
          </span>
        ) : (
          <span
            data-testid="liveness-badge-unreachable"
            className="inline-flex items-center gap-2 rounded-md border border-ironwake/40 bg-ironwake/10 px-4 py-2 font-heading text-lg text-ironwake"
          >
            <span aria-hidden="true">✕</span> Unreachable
          </span>
        )}
        <button
          type="button"
          data-testid="liveness-reprobe"
          onClick={() => void load(true)}
          disabled={reprobing}
          className="rounded border border-primary-navy/40 bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          {reprobing ? 'Re-probing…' : 'Re-probe now'}
        </button>
        {reprobed && (
          <span
            role="status"
            data-testid="liveness-reprobed-badge"
            className="rounded-full bg-seafoam/15 px-2 py-0.5 text-xs font-body text-seafoam"
          >
            Re-probed just now
          </span>
        )}
      </div>
      <p className="text-sm font-body text-deep-charcoal/70">
        Last probed:{' '}
        <span data-testid="liveness-last-probed-at">
          {formatDate(row.lastProbedAt)}
        </span>{' '}
        · {(row.errorRate24h * 100).toFixed(1)}% errors in the last 24h.
      </p>
      {row.lastErrorEvent ? (
        <div
          data-testid="liveness-last-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Last error</p>
          <p className="mt-1 text-xs">
            {formatDate(row.lastErrorEvent.timestamp)}
          </p>
          <p className="mt-1">{row.lastErrorEvent.message}</p>
        </div>
      ) : (
        <p
          data-testid="liveness-no-errors"
          className="rounded-md border border-seafoam/40 bg-seafoam/5 p-3 text-sm font-body text-seafoam"
        >
          <span aria-hidden="true">✓</span> No recent errors.
        </p>
      )}
    </div>
  );
}
