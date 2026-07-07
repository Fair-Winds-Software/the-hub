// Authorized by HUB-1738 (E-V2-PP-2 S9, HUB-1726, HUB-1701) — Custom-quote list view
// at /console/billing/quotes. Status filter defaults to 'pending' (things awaiting the
// operator's review), pagination + auto-refresh every 60s while visible.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';

type QuoteStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'expired' | 'all';

export interface QuoteRow {
  id: string;
  tenant_id: string;
  product_id: string;
  operator_id: string;
  status: Exclude<QuoteStatus, 'all'>;
  total_cents: number;
  currency: string;
  expires_at: string;
  invoice_id: string | null;
  invoiced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteListResponse {
  data: QuoteRow[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

interface LoadState {
  kind: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  payload?: QuoteListResponse;
  message?: string;
}

export interface CustomQuotesProps {
  /** Tenant to list quotes for. Required; the caller (route or parent) provides it. */
  tenantId: string;
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function CustomQuotes({ tenantId }: CustomQuotesProps): React.ReactElement {
  const [statusFilter, setStatusFilter] = useState<QuoteStatus>('pending');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(50);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const params = new URLSearchParams();
      params.set('tenant_id', tenantId);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const payload = await apiClient.get<QuoteListResponse>(
        `/api/v1/admin/billing/quotes?${params.toString()}`,
      );
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load quotes.' });
    }
  }, [tenantId, statusFilter, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  // AC 7: auto-refresh every 60s while page is visible (Page Visibility API).
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    refreshTimerRef.current = setInterval(tick, 60000);
    return () => {
      if (refreshTimerRef.current !== null) clearInterval(refreshTimerRef.current);
    };
  }, [load]);

  const rows = state.kind === 'ready' ? state.payload!.data : [];
  const total = state.kind === 'ready' ? state.payload!.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="mx-auto max-w-6xl p-4" data-testid="custom-quotes-page">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">Custom quotes</h1>
          <p className="text-sm font-body text-deep-charcoal/70">
            Operator-authored quotes for Synapz On-Prem, Social Squeeze consulting, and ContentHelm video.
            Two-role attestation: quote creators cannot approve their own quotes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Status
            <select
              data-testid="quote-status-filter"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as QuoteStatus); setPage(1); }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="pending">Pending</option>
              <option value="draft">Draft</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="expired">Expired</option>
              <option value="all">All</option>
            </select>
          </label>
          <button
            type="button"
            data-testid="quotes-refresh"
            onClick={() => void load()}
            className="rounded border border-deep-charcoal/20 px-2 py-1.5 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Refresh
          </button>
          <Link
            to="/console/billing/quotes/new"
            data-testid="new-quote-link"
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            + New quote
          </Link>
        </div>
      </header>

      {state.kind === 'loading' && (
        <p data-testid="quotes-loading" className="text-sm text-deep-charcoal/70">Loading…</p>
      )}
      {state.kind === 'error' && (
        <p role="alert" data-testid="quotes-error" className="text-sm text-error-crimson">
          {state.message}
        </p>
      )}
      {state.kind === 'denied' && (
        <p role="alert" data-testid="quotes-denied" className="text-sm text-error-crimson">
          You don&apos;t have permission to view this page.
        </p>
      )}

      {state.kind === 'ready' && rows.length === 0 && (
        <div
          data-testid="quotes-empty"
          className="rounded border border-dashed border-deep-charcoal/30 p-6 text-center text-sm font-body text-deep-charcoal/70"
        >
          No quotes found for this filter.
        </div>
      )}

      {state.kind === 'ready' && rows.length > 0 && (
        <>
          <table className="w-full border-collapse text-sm font-body">
            <thead>
              <tr className="border-b border-deep-charcoal/20 text-left text-deep-charcoal/70">
                <th scope="col" className="py-2 pr-2">Created</th>
                <th scope="col" className="py-2 pr-2">Total</th>
                <th scope="col" className="py-2 pr-2">Status</th>
                <th scope="col" className="py-2 pr-2">Expires</th>
                <th scope="col" className="py-2 pr-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.id} data-testid={`quote-row-${q.id}`} className="border-b border-deep-charcoal/10">
                  <td className="py-2 pr-2 text-deep-charcoal">{q.created_at.slice(0, 10)}</td>
                  <td className="py-2 pr-2 text-deep-charcoal">{formatCurrency(q.total_cents)}</td>
                  <td className="py-2 pr-2 text-deep-charcoal">{q.status}</td>
                  <td className="py-2 pr-2 text-deep-charcoal">{q.expires_at.slice(0, 10)}</td>
                  <td className="py-2 pr-2 text-right">
                    <Link
                      to={`/console/billing/quotes/${q.id}`}
                      data-testid={`quote-view-${q.id}`}
                      className="text-xs font-body text-primary-navy underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex flex-col gap-2 text-sm font-body text-deep-charcoal/80 sm:flex-row sm:items-center sm:justify-between">
            <span data-testid="quote-total">
              {total} {total === 1 ? 'quote' : 'quotes'}
            </span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                Per page
                <select
                  data-testid="quote-page-size"
                  value={pageSize}
                  onChange={(e) => { setPageSize(parseInt(e.target.value, 10) as PageSizeOption); setPage(1); }}
                  className="rounded border border-deep-charcoal/20 p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button
                type="button"
                data-testid="quote-prev-page"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40"
              >
                Prev
              </button>
              <span data-testid="quote-page-indicator">Page {page} of {totalPages}</span>
              <button
                type="button"
                data-testid="quote-next-page"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export default CustomQuotes;
