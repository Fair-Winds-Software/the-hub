// Authorized by HUB-1438 (E-CMP-WAVE4b S5) — Policy Register page.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { useRole } from '../stores/sessionStore';
import { PolicyTable } from './policyRegister/PolicyTable';
import { AddPolicyModal } from './policyRegister/AddPolicyModal';
import { AcknowledgePolicyModal } from './policyRegister/AcknowledgePolicyModal';
import type {
  PolicyListResponse, PolicyRow, PolicyStatusFilter, PolicyTypeFilter,
} from './policyRegister/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

interface LoadState {
  kind: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  payload?: PolicyListResponse;
  message?: string;
}

export function PolicyRegister(): React.ReactElement {
  const role = useRole();
  const isAdmin = role === 'super_admin';

  const [statusFilter, setStatusFilter] = useState<PolicyStatusFilter>('active');
  const [typeFilter, setTypeFilter] = useState<PolicyTypeFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(50);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [addOpen, setAddOpen] = useState(false);
  const [ackTarget, setAckTarget] = useState<PolicyRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (typeFilter !== 'all') params.set('policy_type', typeFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const payload = await apiClient.get<PolicyListResponse>(`/api/v1/admin/grc/policies?${params.toString()}`);
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) { setState({ kind: 'denied' }); return; }
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load policies.' });
    }
  }, [statusFilter, typeFilter, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  const onCreated = useCallback((): void => { setAddOpen(false); void load(); }, [load]);
  const onAcknowledged = useCallback((): void => { setAckTarget(null); void load(); }, [load]);

  const rows = state.kind === 'ready' ? state.payload!.data : [];
  const total = state.kind === 'ready' ? state.payload!.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="mx-auto max-w-6xl p-4" data-testid="policy-register-page">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">Policy Register</h1>
          <p className="text-sm font-body text-deep-charcoal/70">
            Policy library + employee acknowledgment tracker. Any authenticated operator may
            acknowledge on behalf of an employee. GRC-Lite Wave 4b.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Status
            <select data-testid="policy-status-filter" value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as PolicyStatusFilter); setPage(1); }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass">
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Type
            <select data-testid="policy-type-filter" value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value as PolicyTypeFilter); setPage(1); }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass">
              <option value="all">All</option>
              <option value="security">Security</option>
              <option value="privacy">Privacy</option>
              <option value="acceptable_use">Acceptable use</option>
              <option value="incident_response">Incident response</option>
              <option value="other">Other</option>
            </select>
          </label>
          {isAdmin && (
            <button type="button" data-testid="add-policy-button" onClick={() => setAddOpen(true)}
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass">
              + Add policy
            </button>
          )}
        </div>
      </header>

      {state.kind === 'loading' && <p data-testid="policy-loading" className="text-sm text-deep-charcoal/70">Loading…</p>}
      {state.kind === 'error' && <p role="alert" data-testid="policy-error" className="text-sm text-error-crimson">{state.message}</p>}
      {state.kind === 'denied' && <p role="alert" data-testid="policy-denied" className="text-sm text-error-crimson">You don&apos;t have permission to view this page.</p>}

      {state.kind === 'ready' && (
        <>
          <PolicyTable rows={rows} isAdmin={isAdmin} onAcknowledge={setAckTarget} />
          <div className="mt-3 flex flex-col gap-2 text-sm font-body text-deep-charcoal/80 sm:flex-row sm:items-center sm:justify-between">
            <span data-testid="policy-total">{total} {total === 1 ? 'policy' : 'policies'}</span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">Per page
                <select data-testid="policy-page-size" value={pageSize}
                  onChange={(e) => { setPageSize(parseInt(e.target.value, 10) as PageSizeOption); setPage(1); }}
                  className="rounded border border-deep-charcoal/20 p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass">
                  {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button type="button" data-testid="policy-prev-page"
                onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40">Prev</button>
              <span data-testid="policy-page-indicator">Page {page} of {totalPages}</span>
              <button type="button" data-testid="policy-next-page"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}

      {isAdmin && addOpen && <AddPolicyModal onClose={() => setAddOpen(false)} onCreated={onCreated} />}
      {ackTarget && <AcknowledgePolicyModal policy={ackTarget} onClose={() => setAckTarget(null)} onAcknowledged={onAcknowledged} />}
    </section>
  );
}

export default PolicyRegister;
