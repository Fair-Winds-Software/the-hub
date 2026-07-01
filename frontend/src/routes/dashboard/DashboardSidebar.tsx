// Authorized by HUB-1648 (E-FE-2 S5) — Dashboard sidebar region. Composes:
//   1. QuickActions row — three <a> buttons (open-in-new-tab friendly) to
//      the operator's daily-flow entry points.
//   2. RecentActivityFeed — last 10 operator_audit_log entries; each row
//      deep-links to /console/audit?eventId=<id> (HUB-1616 highlight
//      contract).
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Quick action target for "New Plan Recommendation": spec named
//      /console/plan-advisor?new=true, but HUB-1639 shipped the flow at
//      the route path /console/plan-advisor/new (App.tsx registers the
//      route accordingly). Using the actual route path so the link
//      resolves; if HUB-1639 ever adds a query-param overlay the FR
//      target can be swapped here in one line.
//
//   2. GET /api/v1/admin/console/audit-log response shape carries
//      operator_id (UUID) not a display name, and product_id (UUID) not
//      a product name. Spec asked for actor display + product context;
//      we render operator_id short-form + product_id short-form until
//      the BE joins the display-name columns (tracked as HUB-1545 tech
//      debt). Row aria-label composes the full sentence so screen
//      readers get the intended summary.
//
//   3. product_admin operators may see the endpoint 400/403 because the
//      RBAC contract requires product_id (per operatorConsole.ts:309).
//      S6 (HUB-1649) owns the RBAC-scope wiring; at S5 we treat any
//      error as a degrade → friendly "activity feed unavailable" panel
//      instead of a hard error banner. The three quick actions and the
//      rest of the dashboard stay fully usable (FR-014).
//
// Authorized by HUB-1649 (E-FE-2 S6) — RBAC scope wiring. The activity
// feed trusts server-side scope enforcement in operatorRbac.ts (per FR-013)
// and renders EXACTLY what the server returns; the FE does NOT re-filter,
// because doing so would mask server bugs where an unscoped row leaked
// through. This is the same server-authoritative contract used by
// HUB-1642 for plan-advisor scope wiring.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../lib/api';

const AUDIT_LOG_PATH = '/api/v1/admin/console/audit-log?limit=10';

interface AuditLogEntry {
  id: string;
  operator_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  tenant_id: string | null;
  product_id: string | null;
  recommendation_id: string | null;
  created_at: string;
}

interface AuditLogResponse {
  data: AuditLogEntry[];
  total: number;
}

type FeedState =
  | { kind: 'loading' }
  | { kind: 'degraded' }
  | { kind: 'ready'; entries: AuditLogEntry[] };

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < MINUTES_PER_HOUR) return `${mins} min ago`;
  if (mins < MINUTES_PER_DAY) {
    const hrs = Math.floor(mins / MINUTES_PER_HOUR);
    return `${hrs} h ago`;
  }
  const days = Math.floor(mins / MINUTES_PER_DAY);
  if (days < 30) return `${days} d ago`;
  const d = new Date(t);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function shortId(id: string | null | undefined): string {
  if (!id) return 'unknown';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function actionVerb(action: string): string {
  // Compress snake_case action codes into a readable verb phrase.
  return action.replace(/_/g, ' ');
}

interface QuickActionDef {
  id: string;
  label: string;
  href: string;
}

const QUICK_ACTIONS: readonly QuickActionDef[] = [
  { id: 'products', label: 'View All Products', href: '/console/products' },
  {
    id: 'new-recommendation',
    label: 'New Plan Recommendation',
    href: '/console/plan-advisor/new',
  },
  { id: 'audit', label: 'View Audit Log', href: '/console/audit' },
] as const;

function QuickActions(): React.ReactElement {
  return (
    <div
      data-testid="dashboard-quick-actions"
      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {QUICK_ACTIONS.map((a) => (
        <Link
          key={a.id}
          to={a.href}
          data-testid={`dashboard-quick-action-${a.id}`}
          className="inline-flex items-center justify-center rounded-md bg-primary-navy px-3 py-2 text-sm font-body text-sailcloth shadow-sm no-underline transition-colors hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          {a.label}
        </Link>
      ))}
    </div>
  );
}

function ActivityRow({
  entry,
}: {
  entry: AuditLogEntry;
}): React.ReactElement {
  const actorLabel = shortId(entry.operator_id);
  const productLabel = shortId(entry.product_id);
  const verb = actionVerb(entry.action);
  const rel = relativeTime(entry.created_at);
  const aria = `Audit event ${entry.id}: ${actorLabel} ${verb} on product ${productLabel}, ${rel}. Click to view in audit log.`;
  return (
    <Link
      to={`/console/audit?eventId=${encodeURIComponent(entry.id)}`}
      data-testid={`activity-row-${entry.id}`}
      aria-label={aria}
      className="flex items-baseline justify-between gap-3 rounded border border-transparent px-2 py-2 text-sm no-underline hover:border-deep-charcoal/10 hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
    >
      <span className="min-w-0 flex-1">
        <span
          data-testid="activity-row-actor"
          className="font-medium text-primary-navy"
        >
          {actorLabel}
        </span>{' '}
        <span
          data-testid="activity-row-verb"
          className="text-deep-charcoal"
        >
          {verb}
        </span>
        {entry.product_id && (
          <>
            {' on '}
            <span
              data-testid="activity-row-product"
              className="text-deep-charcoal"
            >
              {productLabel}
            </span>
          </>
        )}
      </span>
      <span
        data-testid="activity-row-timestamp"
        className="shrink-0 text-xs text-deep-charcoal/60"
      >
        {rel}
      </span>
    </Link>
  );
}

function RecentActivityFeed(): React.ReactElement {
  const [state, setState] = useState<FeedState>({ kind: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await apiClient.get<AuditLogResponse>(AUDIT_LOG_PATH);
      setState({ kind: 'ready', entries: res.data ?? [] });
    } catch {
      // Silent degrade — the quick actions row above stays usable.
      setState({ kind: 'degraded' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-labelledby="dashboard-activity-heading"
      data-testid="dashboard-activity-feed"
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h3
        id="dashboard-activity-heading"
        className="mb-2 font-heading text-base text-primary-navy"
      >
        Recent activity
      </h3>
      {state.kind === 'loading' && (
        <div
          data-testid="dashboard-activity-loading"
          className="flex flex-col gap-2"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-8 animate-pulse rounded bg-deep-charcoal/5"
            />
          ))}
        </div>
      )}
      {state.kind === 'degraded' && (
        <p
          data-testid="dashboard-activity-degraded"
          className="text-sm font-body text-deep-charcoal/60"
        >
          Activity feed unavailable right now — check the audit log directly.
        </p>
      )}
      {state.kind === 'ready' && state.entries.length === 0 && (
        <p
          data-testid="dashboard-activity-empty"
          className="text-sm font-body text-deep-charcoal/60"
        >
          Nothing in the last 24 hours.
        </p>
      )}
      {state.kind === 'ready' && state.entries.length > 0 && (
        <ul
          data-testid="dashboard-activity-list"
          className="flex flex-col gap-1"
        >
          {state.entries.map((e) => (
            <li key={e.id}>
              <ActivityRow entry={e} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DashboardSidebar(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <QuickActions />
      <RecentActivityFeed />
    </div>
  );
}
