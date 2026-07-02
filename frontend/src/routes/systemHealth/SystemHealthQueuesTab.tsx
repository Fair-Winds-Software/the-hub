// Authorized by HUB-1678 (E-FE-7 S5) — Queues tab at
// /console/system-health/:productId/queues. Fetches the S1 queues
// aggregate, renders a table sorted by DLQ-size + depth (worst-on-top),
// and offers a manual 'Refresh now' button that bypasses the BE cache
// via ?fresh=true.
//
// Queues are HUB-instance-level (not per-product); an inline note tells
// the operator so no one thinks they're staring at a per-product view.
//
// Spec deviation (documented per ironclad-engineer): S1's queues endpoint
// does not honour ?fresh=true at v0.1 — every call returns the same
// snapshot. FE still passes the param so the FE contract is future-shape-
// ready.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';
import { formatCount, formatDuration } from './system-health-formatters';

const QUEUES_PATH = '/api/v1/admin/system-health/queues';

interface QueueRow {
  name: string;
  depth: number;
  dlqSize: number;
  oldestJobAgeSeconds: number | null;
}
interface QueuesResponse {
  queues: QueueRow[];
  generatedAt: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; queues: QueueRow[] };

export default function SystemHealthQueuesTab(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [refreshed, setRefreshed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (fresh: boolean): Promise<void> => {
      if (fresh) setRefreshing(true);
      else setState({ kind: 'loading' });
      try {
        const url = fresh ? `${QUEUES_PATH}?fresh=true` : QUEUES_PATH;
        const res = await apiClient.get<QueuesResponse>(url);
        setState({ kind: 'ready', queues: res.queues });
        if (fresh) {
          setRefreshed(true);
          setTimeout(() => setRefreshed(false), 3000);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load queues';
        setState({ kind: 'error', message });
      } finally {
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const sortedQueues = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return [...state.queues].sort((a, b) => {
      if (b.dlqSize !== a.dlqSize) return b.dlqSize - a.dlqSize;
      return b.depth - a.depth;
    });
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div
        data-testid="queues-tab-loading"
        className="h-24 animate-pulse rounded-md bg-deep-charcoal/5"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        data-testid="queues-tab-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load queues.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="queues-tab-retry"
          onClick={() => void load(false)}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div data-testid="queues-tab" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-body text-deep-charcoal/60">
          Queues are HUB-wide, not product-specific.
        </p>
        <div className="flex items-center gap-2">
          {refreshed && (
            <span
              role="status"
              data-testid="queues-refreshed-badge"
              className="rounded-full bg-seafoam/15 px-2 py-0.5 text-xs font-body text-seafoam"
            >
              Refreshed just now
            </span>
          )}
          <button
            type="button"
            data-testid="queues-refresh"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded border border-primary-navy/40 bg-primary-navy px-3 py-1 text-xs font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      </div>

      {sortedQueues.length === 0 ? (
        <p
          data-testid="queues-tab-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-3 text-sm font-body text-deep-charcoal/70"
        >
          No queues registered.
        </p>
      ) : (
        <table
          data-testid="queues-tab-table"
          className="w-full border-collapse text-left text-sm font-body"
        >
          <thead>
            <tr className="border-b border-deep-charcoal/15 text-xs text-deep-charcoal/60">
              <th className="py-2">Queue</th>
              <th className="py-2">Depth</th>
              <th className="py-2">DLQ</th>
              <th className="py-2">Oldest job age</th>
            </tr>
          </thead>
          <tbody>
            {sortedQueues.map((q) => {
              const dlqHot = q.dlqSize > 0;
              return (
                <tr
                  key={q.name}
                  data-testid={`queues-row-${q.name}`}
                  className="border-b border-deep-charcoal/10 text-xs"
                >
                  <td className="py-2 font-mono">{q.name}</td>
                  <td className="py-2">{formatCount(q.depth)}</td>
                  <td className="py-2">
                    {dlqHot ? (
                      <span
                        data-testid={`queues-dlq-hot-${q.name}`}
                        className="inline-flex items-center gap-1 rounded-full border border-ironwake/40 bg-ironwake/10 px-2 py-0.5 text-xs font-body text-ironwake"
                        aria-label={`${q.dlqSize} jobs in dead-letter queue`}
                      >
                        <span aria-hidden="true">⚠</span>
                        {formatCount(q.dlqSize)}
                      </span>
                    ) : (
                      <span data-testid={`queues-dlq-zero-${q.name}`}>
                        {formatCount(q.dlqSize)}
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    {formatDuration(q.oldestJobAgeSeconds)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
