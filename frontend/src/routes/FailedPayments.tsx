// Authorized by HUB-1687 (E-FE-13 S2) — Failed Payment Tracker list at
// /console/failed-payments. Fetches HUB-1686's aggregation endpoint and
// renders a sortable table with 4-way status badges (color + icon +
// text triple-encoding). Row click opens a drawer (wired by S4).
//
// Row selection wiring lands in HUB-1692 S7 (bulk-email) — this story
// only ships the table + badges + relative-time last-failed. Filters
// + counts panel land in HUB-1688 S3. Retry / override actions land
// in HUB-1690 S5 / HUB-1691 S6.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import {
  formatMultiCurrencyCents,
  formatRelativeTime,
  statusLabel,
} from './failedPayments/failed-payments-formatters';

const FAILED_PAYMENTS_PATH = '/api/v1/admin/billing/failed-payments';
const PAGE_TITLE = 'Failed Payments | HUB Console';

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
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const rows = useMemo(() => {
    if (state.kind !== 'ready') return [] as FailedPaymentRow[];
    return state.payload.rows;
  }, [state]);

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

  return (
    <div
      id="main-content"
      data-testid="failed-payments-page"
      className="flex flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl text-primary-navy">
            Failed Payments
          </h1>
          <p
            data-testid="failed-payments-total"
            className="text-xs font-body text-deep-charcoal/70"
          >
            {rows.length} failed payment{rows.length === 1 ? '' : 's'} in the
            last 30 days
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
                    onClick={() => onRowClick?.(r)}
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
  );
}
