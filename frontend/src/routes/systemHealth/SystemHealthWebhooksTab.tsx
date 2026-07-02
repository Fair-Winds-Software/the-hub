// Authorized by HUB-1678 (E-FE-7 S5) — Webhooks tab at
// /console/system-health/:productId/webhooks. Fetches the S1 Stripe
// webhook aggregate + renders four MetricTile-style tiles (Success Rate,
// Successful, Failed, Pending Retries) plus a last-failure line + a
// window selector (24h / 7d) + a manual Refresh button.
//
// Webhook health is HUB-instance-level (not per-product); an inline note
// tells the operator so no one thinks they're staring at a per-product
// view.
//
// Failed / Pending-retry tiles use triple-encoding (color + count +
// warning icon when non-zero) per FR-015.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api';
import { MetricTile } from '../../components/MetricTile';
import {
  formatCount,
  formatPercent,
  formatTimestamp,
} from './system-health-formatters';

const WEBHOOKS_PATH = '/api/v1/admin/system-health/stripe-webhooks';

interface WebhooksResponse {
  successCount: number;
  failureCount: number;
  successRate: number;
  lastFailedAt: string | null;
  pendingRetryCount: number;
  generatedAt: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; payload: WebhooksResponse };

interface WindowOpt {
  label: string;
  hours: number;
}

const WINDOWS: readonly WindowOpt[] = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 7 * 24 },
] as const;

export default function SystemHealthWebhooksTab(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [windowHours, setWindowHours] = useState(24);
  const [refreshed, setRefreshed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (fresh: boolean): Promise<void> => {
      if (fresh) setRefreshing(true);
      else setState({ kind: 'loading' });
      try {
        const params = new URLSearchParams({
          windowHours: String(windowHours),
        });
        if (fresh) params.set('fresh', 'true');
        const res = await apiClient.get<WebhooksResponse>(
          `${WEBHOOKS_PATH}?${params.toString()}`,
        );
        setState({ kind: 'ready', payload: res });
        if (fresh) {
          setRefreshed(true);
          setTimeout(() => setRefreshed(false), 3000);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load webhook health';
        setState({ kind: 'error', message });
      } finally {
        setRefreshing(false);
      }
    },
    [windowHours],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <div
        data-testid="webhooks-tab-loading"
        className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4"
      >
        {[0, 1, 2, 3].map((i) => (
          <MetricTile key={i} title="loading" value={null} loading />
        ))}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        data-testid="webhooks-tab-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load webhook health.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="webhooks-tab-retry"
          onClick={() => void load(false)}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const p = state.payload;
  const failureVerdict = p.failureCount > 0 ? 'error' : 'success';
  const pendingVerdict = p.pendingRetryCount > 0 ? 'warning' : 'success';
  const successVerdict = p.successRate >= 0.99 ? 'success' : p.successRate >= 0.95 ? 'warning' : 'error';

  return (
    <div data-testid="webhooks-tab" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-body text-deep-charcoal/60">
          Stripe webhook health is HUB-wide, not product-specific.
        </p>
        <div className="flex items-center gap-2 text-xs font-body text-deep-charcoal/80">
          <span>Window:</span>
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              type="button"
              data-testid={`webhooks-window-${w.label}`}
              aria-pressed={windowHours === w.hours}
              onClick={() => setWindowHours(w.hours)}
              className={
                windowHours === w.hours
                  ? 'rounded-full bg-primary-navy px-2 py-0.5 text-xs font-body text-sailcloth'
                  : 'rounded-full border border-deep-charcoal/20 px-2 py-0.5 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5'
              }
            >
              {w.label}
            </button>
          ))}
          {refreshed && (
            <span
              role="status"
              data-testid="webhooks-refreshed-badge"
              className="rounded-full bg-seafoam/15 px-2 py-0.5 text-xs font-body text-seafoam"
            >
              Refreshed just now
            </span>
          )}
          <button
            type="button"
            data-testid="webhooks-refresh"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded border border-primary-navy/40 bg-primary-navy px-3 py-1 text-xs font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      </div>

      <div
        data-testid="webhooks-tiles"
        className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4"
      >
        <MetricTile
          title="Success rate"
          value={formatPercent(p.successRate)}
          verdict={successVerdict}
        />
        <MetricTile
          title="Successful"
          value={formatCount(p.successCount)}
          verdict="success"
        />
        <MetricTile
          title="Failed"
          value={formatCount(p.failureCount)}
          verdict={failureVerdict}
        />
        <MetricTile
          title="Pending retries"
          value={formatCount(p.pendingRetryCount)}
          verdict={pendingVerdict}
        />
      </div>

      <p
        data-testid="webhooks-last-failure"
        className="text-xs font-body text-deep-charcoal/70"
      >
        {p.lastFailedAt
          ? `Last failure: ${formatTimestamp(p.lastFailedAt)}`
          : `No failures in the last ${WINDOWS.find((w) => w.hours === windowHours)?.label ?? '24h'}.`}
      </p>
    </div>
  );
}
