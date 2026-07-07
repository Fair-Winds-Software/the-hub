// Authorized by HUB-1437 (E-CMP-WAVE4b S4) — Cloud Infrastructure Register page.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { useRole } from '../stores/sessionStore';
import { CloudTable } from './cloudRegister/CloudTable';
import { AddCloudModal } from './cloudRegister/AddCloudModal';
import { AttestCloudModal } from './cloudRegister/AttestCloudModal';
import type {
  CloudListResponse, CloudProviderFilter, CloudRow, CloudStatusFilter,
} from './cloudRegister/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

interface LoadState {
  kind: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  payload?: CloudListResponse;
  message?: string;
}

export function CloudRegister(): React.ReactElement {
  const role = useRole();
  const isAdmin = role === 'super_admin';

  const [statusFilter, setStatusFilter] = useState<CloudStatusFilter>('active');
  const [providerFilter, setProviderFilter] = useState<CloudProviderFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(50);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [addOpen, setAddOpen] = useState(false);
  const [attestTarget, setAttestTarget] = useState<CloudRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (providerFilter !== 'all') params.set('provider', providerFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const payload = await apiClient.get<CloudListResponse>(`/api/v1/admin/grc/cloud?${params.toString()}`);
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) { setState({ kind: 'denied' }); return; }
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load cloud accounts.' });
    }
  }, [statusFilter, providerFilter, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  const onCreated = useCallback((): void => { setAddOpen(false); void load(); }, [load]);
  const onAttested = useCallback((): void => { setAttestTarget(null); void load(); }, [load]);

  const rows = state.kind === 'ready' ? state.payload!.data : [];
  const total = state.kind === 'ready' ? state.payload!.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="mx-auto max-w-6xl p-4" data-testid="cloud-register-page">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">Cloud Infrastructure Register</h1>
          <p className="text-sm font-body text-deep-charcoal/70">Cloud account inventory + security attestations. GRC-Lite Wave 4b.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Status
            <select data-testid="cloud-status-filter" value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as CloudStatusFilter); setPage(1); }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass">
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Provider
            <select data-testid="cloud-provider-filter" value={providerFilter}
              onChange={(e) => { setProviderFilter(e.target.value as CloudProviderFilter); setPage(1); }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass">
              <option value="all">All</option>
              <option value="aws">AWS</option>
              <option value="gcp">GCP</option>
              <option value="azure">Azure</option>
              <option value="other">Other</option>
            </select>
          </label>
          {isAdmin && (
            <button type="button" data-testid="add-cloud-button" onClick={() => setAddOpen(true)}
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass">
              + Add account
            </button>
          )}
        </div>
      </header>

      {state.kind === 'loading' && <p data-testid="cloud-loading" className="text-sm text-deep-charcoal/70">Loading…</p>}
      {state.kind === 'error' && <p role="alert" data-testid="cloud-error" className="text-sm text-error-crimson">{state.message}</p>}
      {state.kind === 'denied' && <p role="alert" data-testid="cloud-denied" className="text-sm text-error-crimson">You don&apos;t have permission to view this page.</p>}

      {state.kind === 'ready' && (
        <>
          <CloudTable rows={rows} isAdmin={isAdmin} onAttest={setAttestTarget} />
          <div className="mt-3 flex flex-col gap-2 text-sm font-body text-deep-charcoal/80 sm:flex-row sm:items-center sm:justify-between">
            <span data-testid="cloud-total">{total} {total === 1 ? 'account' : 'accounts'}</span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">Per page
                <select data-testid="cloud-page-size" value={pageSize}
                  onChange={(e) => { setPageSize(parseInt(e.target.value, 10) as PageSizeOption); setPage(1); }}
                  className="rounded border border-deep-charcoal/20 p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass">
                  {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button type="button" data-testid="cloud-prev-page"
                onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40">Prev</button>
              <span data-testid="cloud-page-indicator">Page {page} of {totalPages}</span>
              <button type="button" data-testid="cloud-next-page"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}

      {isAdmin && addOpen && <AddCloudModal onClose={() => setAddOpen(false)} onCreated={onCreated} />}
      {isAdmin && attestTarget && <AttestCloudModal account={attestTarget} onClose={() => setAttestTarget(null)} onAttested={onAttested} />}
    </section>
  );
}

export default CloudRegister;
