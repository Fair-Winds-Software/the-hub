// Authorized by HUB-1677 (E-FE-7 S4) — Errors tab at
// /console/system-health/:productId/errors. Fetches the S1
// audit-errors endpoint with a window selector, renders a table with a
// truncated message column, and opens the HUB-1611 SideDrawer with the
// full event payload when a row is clicked. Drawer state syncs to the
// URL via ?eventId=<id>.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Row 'action' column: S1 returns eventType (e.g., 'auth.login
//      .failure') not a distinct action column. The FE surfaces the
//      eventType in the action column since it's the closest semantic.
//
//   2. Actor identity: S1 returns actorId (a UUID). No display-name
//      join exists at v0.1; the column surfaces the short-id. HUB-1545
//      tech debt candidate — resolve to email via the operators list.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { SideDrawer } from '../../components/SideDrawer';
import { formatDate } from '../productDetail/pricing-formatters';

const AUDIT_ERRORS_PATH = '/api/v1/admin/system-health/audit-errors';

interface AuditError {
  id: string;
  tenantId: string | null;
  productId: string | null;
  actorId: string | null;
  eventType: string | null;
  message: string | null;
  occurredAt: string;
}

interface AuditErrorsResponse {
  errors: AuditError[];
  generatedAt: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; errors: AuditError[] };

interface WindowOpt {
  label: string;
  hours: number;
}

const WINDOWS: readonly WindowOpt[] = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 7 * 24 },
  { label: '30d', hours: 30 * 24 },
] as const;

function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function truncate(s: string | null, max: number): string {
  if (!s) return '—';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export default function SystemHealthErrorsTab(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [windowHours, setWindowHours] = useState(24);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const qs = new URLSearchParams({
        productId,
        windowHours: String(windowHours),
      });
      const res = await apiClient.get<AuditErrorsResponse>(
        `${AUDIT_ERRORS_PATH}?${qs.toString()}`,
      );
      setState({ kind: 'ready', errors: res.errors });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load errors';
      setState({ kind: 'error', message });
    }
  }, [productId, windowHours]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEventId = searchParams.get('eventId');
  const openEvent = useMemo<AuditError | null>(() => {
    if (state.kind !== 'ready' || !openEventId) return null;
    return state.errors.find((e) => e.id === openEventId) ?? null;
  }, [state, openEventId]);

  const closeDrawer = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('eventId');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const openRow = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('eventId', id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  if (state.kind === 'loading') {
    return (
      <div
        data-testid="errors-tab-loading"
        className="h-24 animate-pulse rounded-md bg-deep-charcoal/5"
      />
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        data-testid="errors-tab-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load errors.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="errors-tab-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const windowLabel = WINDOWS.find((w) => w.hours === windowHours)?.label ?? '24h';

  return (
    <div data-testid="errors-tab" className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
        <span>Window:</span>
        {WINDOWS.map((w) => (
          <button
            key={w.hours}
            type="button"
            data-testid={`errors-window-${w.label}`}
            onClick={() => setWindowHours(w.hours)}
            aria-pressed={windowHours === w.hours}
            className={
              windowHours === w.hours
                ? 'rounded-full bg-primary-navy px-2 py-0.5 text-xs font-body text-sailcloth'
                : 'rounded-full border border-deep-charcoal/20 px-2 py-0.5 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5'
            }
          >
            {w.label}
          </button>
        ))}
      </div>

      {state.errors.length === 0 ? (
        <p
          data-testid="errors-tab-empty"
          className="rounded-md border border-seafoam/40 bg-seafoam/5 p-3 text-sm font-body text-seafoam"
        >
          <span aria-hidden="true">✓</span> No errors in the last {windowLabel}.
        </p>
      ) : (
        <table
          data-testid="errors-tab-table"
          className="w-full border-collapse text-left text-sm font-body"
        >
          <thead>
            <tr className="border-b border-deep-charcoal/15 text-xs text-deep-charcoal/60">
              <th className="py-2">Timestamp</th>
              <th className="py-2">Actor</th>
              <th className="py-2">Action</th>
              <th className="py-2">Message</th>
            </tr>
          </thead>
          <tbody>
            {state.errors.map((e) => (
              <tr
                key={e.id}
                data-testid={`errors-row-${e.id}`}
                tabIndex={0}
                role="button"
                aria-label={`Open error ${e.id} — ${e.eventType ?? 'unknown'}`}
                onClick={() => openRow(e.id)}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    openRow(e.id);
                  }
                }}
                className="cursor-pointer border-b border-deep-charcoal/10 text-xs hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                <td className="py-2">{formatDate(e.occurredAt)}</td>
                <td className="py-2 font-mono">{shortId(e.actorId)}</td>
                <td className="py-2">{e.eventType ?? '—'}</td>
                <td className="py-2">{truncate(e.message, 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SideDrawer
        open={openEvent !== null}
        onClose={closeDrawer}
        title={openEvent ? `Error ${openEvent.id}` : 'Error detail'}
        size="md"
      >
        {openEvent && (
          <div
            data-testid={`errors-drawer-${openEvent.id}`}
            className="flex flex-col gap-3 text-sm font-body text-deep-charcoal"
          >
            <div>
              <p className="text-xs text-deep-charcoal/60">Occurred at</p>
              <p>{formatDate(openEvent.occurredAt)}</p>
            </div>
            <div>
              <p className="text-xs text-deep-charcoal/60">Actor</p>
              <p className="font-mono">{openEvent.actorId ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-deep-charcoal/60">Action</p>
              <p>{openEvent.eventType ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-deep-charcoal/60">Message</p>
              <p data-testid="errors-drawer-full-message">
                {openEvent.message ?? '—'}
              </p>
            </div>
            <Link
              to={`/console/audit?eventId=${encodeURIComponent(openEvent.id)}`}
              data-testid="errors-drawer-audit-link"
              className="mt-2 inline-block text-xs font-body text-primary-navy underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              View in Audit Explorer →
            </Link>
          </div>
        )}
      </SideDrawer>
    </div>
  );
}
