// Authorized by HUB-1436 (E-CMP-WAVE4b S3) — Vendor Register page. Structural mirror
// of DeviceRegister (HUB-1396) applied to the vendor triad from HUB-1423 API.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { useRole } from '../stores/sessionStore';
import { useToastStore } from '../stores/toastStore';
import { VendorTable } from './vendorRegister/VendorTable';
import { AddVendorModal } from './vendorRegister/AddVendorModal';
import { AssessVendorModal } from './vendorRegister/AssessVendorModal';
import type {
  VendorListResponse, VendorRiskFilter, VendorRow, VendorStatusFilter,
} from './vendorRegister/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

interface LoadState {
  kind: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  payload?: VendorListResponse;
  message?: string;
}

export function VendorRegister(): React.ReactElement {
  const role = useRole();
  const isAdmin = role === 'super_admin';
  const addToast = useToastStore((s) => s.addToast);

  const [statusFilter, setStatusFilter] = useState<VendorStatusFilter>('active');
  const [riskFilter, setRiskFilter] = useState<VendorRiskFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(50);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [addOpen, setAddOpen] = useState(false);
  const [assessTarget, setAssessTarget] = useState<VendorRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (riskFilter !== 'all') params.set('risk_level', riskFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const payload = await apiClient.get<VendorListResponse>(`/api/v1/admin/grc/vendors?${params.toString()}`);
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) { setState({ kind: 'denied' }); return; }
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load vendors.' });
    }
  }, [statusFilter, riskFilter, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  const onCreated = useCallback((): void => { setAddOpen(false); void load(); }, [load]);
  const onAssessed = useCallback((): void => { setAssessTarget(null); void load(); }, [load]);

  const onArchive = useCallback(async (row: VendorRow): Promise<void> => {
    const proceed = window.confirm(`Archive ${row.vendor_name}? This soft-deletes the vendor.`);
    if (!proceed) return;
    try {
      await apiClient.delete(`/api/v1/admin/grc/vendors/${row.id}`);
      addToast({ variant: 'success', message: 'Vendor archived.' });
      void load();
    } catch (err) {
      addToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to archive vendor.' });
    }
  }, [addToast, load]);

  const rows = state.kind === 'ready' ? state.payload!.data : [];
  const total = state.kind === 'ready' ? state.payload!.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="mx-auto max-w-6xl p-4" data-testid="vendor-register-page">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">Vendor Register</h1>
          <p className="text-sm font-body text-deep-charcoal/70">Third-party vendor inventory + risk assessments. GRC-Lite Wave 4b.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Status
            <select
              data-testid="vendor-status-filter" value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as VendorStatusFilter); setPage(1); }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Risk
            <select
              data-testid="vendor-risk-filter" value={riskFilter}
              onChange={(e) => { setRiskFilter(e.target.value as VendorRiskFilter); setPage(1); }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="all">All</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          {isAdmin && (
            <button type="button" data-testid="add-vendor-button" onClick={() => setAddOpen(true)}
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass">
              + Add vendor
            </button>
          )}
        </div>
      </header>

      {state.kind === 'loading' && <p data-testid="vendor-loading" className="text-sm text-deep-charcoal/70">Loading…</p>}
      {state.kind === 'error' && <p role="alert" data-testid="vendor-error" className="text-sm text-error-crimson">{state.message}</p>}
      {state.kind === 'denied' && <p role="alert" data-testid="vendor-denied" className="text-sm text-error-crimson">You don&apos;t have permission to view this page.</p>}

      {state.kind === 'ready' && (
        <>
          <VendorTable rows={rows} isAdmin={isAdmin} onAssess={setAssessTarget} onArchive={(r) => void onArchive(r)} />
          <div className="mt-3 flex flex-col gap-2 text-sm font-body text-deep-charcoal/80 sm:flex-row sm:items-center sm:justify-between">
            <span data-testid="vendor-total">{total} {total === 1 ? 'vendor' : 'vendors'}</span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">Per page
                <select
                  data-testid="vendor-page-size" value={pageSize}
                  onChange={(e) => { setPageSize(parseInt(e.target.value, 10) as PageSizeOption); setPage(1); }}
                  className="rounded border border-deep-charcoal/20 p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button type="button" data-testid="vendor-prev-page"
                onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40">Prev</button>
              <span data-testid="vendor-page-indicator">Page {page} of {totalPages}</span>
              <button type="button" data-testid="vendor-next-page"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}

      {isAdmin && addOpen && <AddVendorModal onClose={() => setAddOpen(false)} onCreated={onCreated} />}
      {isAdmin && assessTarget && <AssessVendorModal vendor={assessTarget} onClose={() => setAssessTarget(null)} onAssessed={onAssessed} />}
    </section>
  );
}

export default VendorRegister;
