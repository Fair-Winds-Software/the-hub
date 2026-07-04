// Authorized by HUB-1687 (E-FE-13 S2) — Failed Payment Tracker list at
// /console/failed-payments. Fetches HUB-1686's aggregation endpoint and
// renders a sortable table with 4-way status badges.
// Authorized by HUB-1688 (E-FE-13 S3) — Filter sidebar (status multi-
// select + product dropdown + date range) with URL-synced state via
// useSearchParams; counts panel shows the raw counts per status
// (unaffected by the status filter, so operators always see the
// portfolio-level shape).
//
// Row selection wiring lands in HUB-1692 S7 (bulk-email); drawer opens
// via onRowClick lands in HUB-1689 S4.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import {
  formatMultiCurrencyCents,
  formatRelativeTime,
  statusLabel,
} from './failedPayments/failed-payments-formatters';
import {
  FailedPaymentsFilters,
  type FailedPaymentsFilterValue,
  type FailedPaymentsProduct,
  type StatusCounts,
} from './failedPayments/FailedPaymentsFilters';
import { FailedPaymentsDrawer } from './failedPayments/FailedPaymentsDrawer';

const FAILED_PAYMENTS_PATH = '/api/v1/admin/billing/failed-payments';
const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Failed Payments | HUB Console';

function parseFilters(sp: URLSearchParams): FailedPaymentsFilterValue {
  const statusRaw = sp.get('status') ?? '';
  const statuses = statusRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is FailedPaymentStatus =>
      s === 'pending_retry' ||
      s === 'exhausted' ||
      s === 'recovered' ||
      s === 'overridden',
    );
  return {
    statuses,
    productId: sp.get('product'),
    from: sp.get('from'),
    to: sp.get('to'),
  };
}

function filtersToSearchParams(f: FailedPaymentsFilterValue): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.statuses.length > 0) sp.set('status', f.statuses.join(','));
  if (f.productId) sp.set('product', f.productId);
  if (f.from) sp.set('from', f.from);
  if (f.to) sp.set('to', f.to);
  return sp;
}

export type FailedPaymentStatus =
  | 'pending_retry'
  | 'exhausted'
  | 'recovered'
  | 'overridden';

export interface FailedPaymentRow {
  id: string;
  invoiceId: string;
  tenantId: string;
  tenantName: string;
  productId: string;
  amountCents: number;
  currency: string;
  failureReason: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastRetryTriggeredAt: string | null;
  status: FailedPaymentStatus;
  createdAt: string;
}

export interface FailedPaymentsResponse {
  rows: FailedPaymentRow[];
  total: number;
  generatedAt: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; payload: FailedPaymentsResponse };

interface StatusBadgeProps {
  status: FailedPaymentStatus;
}

function StatusBadge({ status }: StatusBadgeProps): React.ReactElement {
  // Triple-encoded per Ironclad — color + icon + text label. Greyscale
  // rendering keeps the sign visible via the icon + text.
  const label = statusLabel(status);
  const icon =
    status === 'pending_retry'
      ? '⏳'
      : status === 'exhausted'
        ? '✕'
        : status === 'recovered'
          ? '✓'
          : '⊘';
  const classes =
    status === 'pending_retry'
      ? 'border-accent-brass/40 bg-accent-brass/10 text-accent-brass'
      : status === 'exhausted'
        ? 'border-ironwake/40 bg-ironwake/10 text-ironwake'
        : status === 'recovered'
          ? 'border-seafoam/40 bg-seafoam/10 text-seafoam'
          : 'border-deep-charcoal/25 bg-deep-charcoal/5 text-deep-charcoal/70';
  return (
    <span
      data-testid={`failed-payment-badge-${status}`}
      aria-label={`Status: ${label}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-body ${classes}`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

export interface FailedPaymentsProps {
  onRowClick?: (row: FailedPaymentRow) => void;
}

export default function FailedPayments({
  onRowClick,
}: FailedPaymentsProps): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const [products, setProducts] = useState<FailedPaymentsProduct[]>([]);
  const [openRowId, setOpenRowId] = useState<string | null>(null);

  const handleRowClick = useCallback(
    (row: FailedPaymentRow): void => {
      setOpenRowId(row.id);
      onRowClick?.(row);
    },
    [onRowClick],
  );

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
      // Only pass product + date-range filters to the BE. Status filter
      // is applied CLIENT-side so the counts panel can reflect the
      // portfolio-level shape regardless of the status filter.
      const params = new URLSearchParams();
      if (filters.productId) params.set('productId', filters.productId);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (fresh) params.set('fresh', 'true');
      const url = params.toString()
        ? `${FAILED_PAYMENTS_PATH}?${params.toString()}`
        : FAILED_PAYMENTS_PATH;
      const payload = await apiClient.get<FailedPaymentsResponse>(url);
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Failed to load failed payments';
      setState({ kind: 'error', message });
    }
  }, [filters.productId, filters.from, filters.to]);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Populate product dropdown (product_admin gets a server-scoped list).
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ data: FailedPaymentsProduct[] }>(PORTFOLIO_PATH)
      .then((res) => {
        if (!cancelled) setProducts(res.data);
      })
      .catch(() => {
        if (!cancelled) setProducts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFiltersChange = useCallback(
    (next: FailedPaymentsFilterValue) => {
      setSearchParams(filtersToSearchParams(next), { replace: true });
    },
    [setSearchParams],
  );
  const handleReset = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [setSearchParams]);

  const allRows = useMemo(() => {
    if (state.kind !== 'ready') return [] as FailedPaymentRow[];
    return state.payload.rows;
  }, [state]);

  // Counts panel: raw counts per status BEFORE the status filter is
  // applied so the operator always sees the portfolio-level shape.
  const counts = useMemo<StatusCounts>(() => {
    const c: StatusCounts = {
      pending_retry: 0,
      exhausted: 0,
      recovered: 0,
      overridden: 0,
    };
    for (const r of allRows) c[r.status] += 1;
    return c;
  }, [allRows]);

  // Table rows: apply the client-side status filter.
  const rows = useMemo(() => {
    if (filters.statuses.length === 0) return allRows;
    const set = new Set(filters.statuses);
    return allRows.filter((r) => set.has(r.status));
  }, [allRows, filters.statuses]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="failed-payments-page-loading"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="failed-payments-skeleton"
          className="h-64 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }
  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="Failed Payments"
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
        data-testid="failed-payments-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load Failed Payments.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="failed-payments-retry"
          onClick={() => void load(false)}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const hasActiveFilters =
    filters.statuses.length > 0 ||
    filters.productId !== null ||
    filters.from !== null ||
    filters.to !== null;
  return (
    <div
      id="main-content"
      data-testid="failed-payments-page"
      className="flex flex-col gap-4 md:flex-row md:items-start"
    >
      <FailedPaymentsFilters
        value={filters}
        onChange={handleFiltersChange}
        onReset={handleReset}
        products={products}
        counts={counts}
      />
      <div className="flex flex-1 flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl text-primary-navy">
            Failed Payments
          </h1>
          <p
            data-testid="failed-payments-total"
            className="text-xs font-body text-deep-charcoal/70"
          >
            {rows.length} failed payment{rows.length === 1 ? '' : 's'}
            {hasActiveFilters ? ' matching filters' : ' in the last 30 days'}
          </p>
        </div>
        <button
          type="button"
          data-testid="failed-payments-refresh"
          onClick={() => void load(true)}
          className="rounded border border-deep-charcoal/20 bg-sailcloth px-3 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Refresh now
        </button>
      </header>

      {rows.length === 0 ? (
        <div
          data-testid="failed-payments-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          No failed payments in this window. Widen the date range in the
          filters to see older entries.
        </div>
      ) : (
        <table
          data-testid="failed-payments-table"
          className="w-full border-collapse text-left text-sm font-body"
        >
          <thead>
            <tr className="border-b border-deep-charcoal/15 text-xs text-deep-charcoal/60">
              <th scope="col" className="py-2 text-left">
                Failed at
              </th>
              <th scope="col" className="py-2 text-left">
                Tenant
              </th>
              <th scope="col" className="py-2 text-left">
                Amount
              </th>
              <th scope="col" className="py-2 text-left">
                Reason
              </th>
              <th scope="col" className="py-2 text-left">
                Attempts
              </th>
              <th scope="col" className="py-2 text-left">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                data-testid={`failed-payments-row-${r.id}`}
                className="border-b border-deep-charcoal/10 hover:bg-deep-charcoal/5"
              >
                <td className="py-2 text-xs font-mono text-deep-charcoal/80">
                  {formatRelativeTime(r.createdAt)}
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    data-testid={`failed-payments-row-link-${r.id}`}
                    onClick={() => handleRowClick(r)}
                    className="text-primary-navy underline decoration-primary-navy/40 underline-offset-2 hover:decoration-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                  >
                    {r.tenantName}
                  </button>
                </td>
                <td className="py-2 text-xs font-mono text-deep-charcoal">
                  {formatMultiCurrencyCents(r.amountCents, r.currency)}
                </td>
                <td className="py-2 text-xs text-deep-charcoal/80">
                  {r.failureReason ?? '—'}
                </td>
                <td className="py-2 text-xs font-mono text-deep-charcoal/80">
                  {r.attemptCount} of {r.maxAttempts}
                </td>
                <td className="py-2">
                  <StatusBadge status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </div>
      <FailedPaymentsDrawer
        invoiceRowId={openRowId}
        onClose={() => setOpenRowId(null)}
        onActionComplete={() => void load(true)}
      />
    </div>
  );
}
