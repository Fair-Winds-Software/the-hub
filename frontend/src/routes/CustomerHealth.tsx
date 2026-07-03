// Authorized by HUB-1681 (E-FE-9 S2) — Customer Health list at
// /console/customer-health. Fetches HUB-1680's aggregation endpoint and
// renders a sortable table with a triple-encoded health badge per row
// (color + icon + text), MRR formatted via S6's formatCurrency, last-
// active as relative time. Default sort = churn-risk DESC.
//
// Row navigation: entire row is a semantic <Link> to
// /console/customer-health/:tenantId?productId=... (drill-in wired by
// HUB-1683 S4). Keyboard-navigable + focus ring per Ironclad a11y.
//
// Threshold-driven tooltip on the churn-score column reads
// response.meta.thresholds.red so the "≥0.7 = high risk" text stays
// accurate when Sammy retunes without a code deploy (single-source-of-
// truth pattern set by HUB-1674 systemHealth meta.threshold).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import {
  formatCurrency,
  formatRelativeTime,
  formatScore,
  badgeToRiskLevel,
} from './customerHealth/customer-health-formatters';

const HEALTH_PATH = '/api/v1/admin/customer-health';
const PAGE_TITLE = 'Customer Health | HUB Console';

export type HealthBadge = 'red' | 'yellow' | 'green';

export interface HealthListRow {
  tenantId: string;
  tenantName: string;
  productId: string;
  productName: string;
  planKey: string | null;
  mrrCents: number | null;
  healthBadge: HealthBadge;
  churnRiskScore: number;
  lastActiveAt: string | null;
  signals: string[];
}

export interface HealthListResponse {
  rows: HealthListRow[];
  total: number;
  generatedAt: string;
  meta: { thresholds: { red: number; yellow: number; staleDays: number } };
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; payload: HealthListResponse };

type SortKey = 'risk' | 'mrr' | 'name';

interface HealthBadgeProps {
  badge: HealthBadge;
}

function HealthBadgeCell({ badge }: HealthBadgeProps): React.ReactElement {
  // Triple-encoded per Ironclad: color + icon + text label. Greyscale
  // rendering still shows the icon + text (verified by S6 a11y test).
  const label = badgeToRiskLevel(badge);
  const displayLabel =
    badge === 'red' ? 'At risk' : badge === 'yellow' ? 'Watch' : 'Healthy';
  const icon = badge === 'red' ? '✕' : badge === 'yellow' ? '⚠' : '✓';
  const classes =
    badge === 'red'
      ? 'border-ironwake/40 bg-ironwake/10 text-ironwake'
      : badge === 'yellow'
        ? 'border-accent-brass/40 bg-accent-brass/10 text-accent-brass'
        : 'border-seafoam/40 bg-seafoam/10 text-seafoam';
  return (
    <span
      data-testid={`customer-health-badge-${badge}`}
      aria-label={`Risk level: ${label}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-body ${classes}`}
    >
      <span aria-hidden="true">{icon}</span>
      {displayLabel}
    </span>
  );
}

interface SortHeaderProps {
  label: string;
  colKey: SortKey;
  activeKey: SortKey;
  direction: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}

function SortHeader({
  label,
  colKey,
  activeKey,
  direction,
  onSort,
}: SortHeaderProps): React.ReactElement {
  const isActive = activeKey === colKey;
  const ariaSort = isActive
    ? direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  const chevron = !isActive ? '' : direction === 'asc' ? '▲' : '▼';
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className="py-2 text-left text-xs font-body text-deep-charcoal/60"
    >
      <button
        type="button"
        data-testid={`customer-health-sort-${colKey}`}
        onClick={() => onSort(colKey)}
        className="inline-flex items-center gap-1 hover:text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        {label}
        {chevron && <span aria-hidden="true">{chevron}</span>}
      </button>
    </th>
  );
}

export default function CustomerHealth(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sortKey, setSortKey] = useState<SortKey>('risk');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const load = useCallback(async (fresh: boolean = false): Promise<void> => {
    if (!fresh) setState({ kind: 'loading' });
    try {
      const params = new URLSearchParams();
      params.set('sortBy', sortKey);
      if (fresh) params.set('fresh', 'true');
      const payload = await apiClient.get<HealthListResponse>(
        `${HEALTH_PATH}?${params.toString()}`,
      );
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Failed to load customer health';
      setState({ kind: 'error', message });
    }
  }, [sortKey]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        // Toggle direction on the same column.
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir(key === 'risk' || key === 'mrr' ? 'desc' : 'asc');
      return key;
    });
  }, []);

  const rowsSorted = useMemo(() => {
    if (state.kind !== 'ready') return [] as HealthListRow[];
    const rows = state.payload.rows.slice();
    // BE already sorts by sortKey DESC; if the user toggles to ASC we
    // reverse client-side (avoids a second round-trip for a UX toggle).
    if (sortDir === 'asc') rows.reverse();
    return rows;
  }, [state, sortDir]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="customer-health-page-loading"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="customer-health-skeleton"
          className="h-64 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }

  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="Customer Health"
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
        data-testid="customer-health-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load Customer Health.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="customer-health-retry"
          onClick={() => void load(false)}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const { payload } = state;
  const redThresholdPct = (payload.meta.thresholds.red * 100).toFixed(0);
  return (
    <div
      id="main-content"
      data-testid="customer-health-page"
      className="flex flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl text-primary-navy">
            Customer Health
          </h1>
          <p
            data-testid="customer-health-total"
            className="text-xs font-body text-deep-charcoal/70"
          >
            {payload.total} tenant{payload.total === 1 ? '' : 's'} in view · sorted
            by {sortKey === 'risk' ? 'churn risk' : sortKey === 'mrr' ? 'MRR' : 'name'}
          </p>
        </div>
        <button
          type="button"
          data-testid="customer-health-refresh"
          onClick={() => void load(true)}
          className="rounded border border-deep-charcoal/20 bg-sailcloth px-3 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Refresh now
        </button>
      </header>

      {rowsSorted.length === 0 ? (
        <div
          data-testid="customer-health-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          No tenants in view yet — check back once the underlying products have
          usage.
        </div>
      ) : (
        <table
          data-testid="customer-health-table"
          className="w-full border-collapse text-left text-sm font-body"
        >
          <thead>
            <tr className="border-b border-deep-charcoal/15">
              <SortHeader
                label="Tenant"
                colKey="name"
                activeKey={sortKey}
                direction={sortDir}
                onSort={handleSort}
              />
              <th
                scope="col"
                className="py-2 text-left text-xs font-body text-deep-charcoal/60"
              >
                Product
              </th>
              <th
                scope="col"
                className="py-2 text-left text-xs font-body text-deep-charcoal/60"
              >
                Plan
              </th>
              <SortHeader
                label="MRR"
                colKey="mrr"
                activeKey={sortKey}
                direction={sortDir}
                onSort={handleSort}
              />
              <th
                scope="col"
                className="py-2 text-left text-xs font-body text-deep-charcoal/60"
              >
                Health
              </th>
              <SortHeader
                label="Churn risk"
                colKey="risk"
                activeKey={sortKey}
                direction={sortDir}
                onSort={handleSort}
              />
              <th
                scope="col"
                className="py-2 text-left text-xs font-body text-deep-charcoal/60"
              >
                Last active
              </th>
            </tr>
          </thead>
          <tbody>
            {rowsSorted.map((r) => {
              const drillTo = `/console/customer-health/${r.tenantId}?productId=${r.productId}`;
              const atRiskAccent =
                r.healthBadge === 'red'
                  ? 'border-l-4 border-l-ironwake'
                  : 'border-l-4 border-l-transparent';
              return (
                <tr
                  key={`${r.tenantId}:${r.productId}`}
                  data-testid={`customer-health-row-${r.tenantId}`}
                  className={`border-b border-deep-charcoal/10 hover:bg-deep-charcoal/5 ${atRiskAccent}`}
                >
                  <td className="py-2">
                    <Link
                      to={drillTo}
                      data-testid={`customer-health-row-link-${r.tenantId}`}
                      className="text-primary-navy underline decoration-primary-navy/40 underline-offset-2 hover:decoration-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                    >
                      {r.tenantName}
                    </Link>
                  </td>
                  <td className="py-2 text-xs text-deep-charcoal/80">
                    {r.productName}
                  </td>
                  <td className="py-2 text-xs font-mono text-deep-charcoal/80">
                    {r.planKey ?? '—'}
                  </td>
                  <td className="py-2 text-xs text-deep-charcoal">
                    {formatCurrency(r.mrrCents)}
                  </td>
                  <td className="py-2">
                    <HealthBadgeCell badge={r.healthBadge} />
                  </td>
                  <td
                    className="py-2 text-xs font-mono text-deep-charcoal"
                    title={`≥${redThresholdPct}% = high risk, action recommended`}
                  >
                    {formatScore(r.churnRiskScore)}
                  </td>
                  <td className="py-2 text-xs text-deep-charcoal/70">
                    {formatRelativeTime(r.lastActiveAt)}
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
