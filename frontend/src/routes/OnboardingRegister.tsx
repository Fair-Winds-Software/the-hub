// Authorized by HUB-1397 (E-CMP-WAVE4 S4) — HR Onboarding Register page. Structural
// mirror of DeviceRegister (HUB-1396); reuses the same admin/read-only pattern,
// pagination controls, and native window.confirm for the Mark Complete action.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { useRole } from '../stores/sessionStore';
import { useToastStore } from '../stores/toastStore';
import { OnboardingTable } from './onboardingRegister/OnboardingTable';
import { AddOnboardingModal } from './onboardingRegister/AddOnboardingModal';
import type {
  OnboardingListResponse,
  OnboardingRow,
  OnboardingStatusFilter,
} from './onboardingRegister/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

interface LoadState {
  kind: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  payload?: OnboardingListResponse;
  message?: string;
}

export function OnboardingRegister(): React.ReactElement {
  const role = useRole();
  const isAdmin = role === 'super_admin';
  const addToast = useToastStore((s) => s.addToast);

  const [statusFilter, setStatusFilter] = useState<OnboardingStatusFilter>('pending');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(50);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const payload = await apiClient.get<OnboardingListResponse>(
        `/api/v1/admin/grc/onboarding?${params.toString()}`,
      );
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load onboarding records.',
      });
    }
  }, [statusFilter, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  const onCreated = useCallback((): void => {
    setAddOpen(false);
    void load();
  }, [load]);

  const onComplete = useCallback(
    async (row: OnboardingRow): Promise<void> => {
      const proceed = window.confirm(
        `Mark ${row.employee_name} onboarding as complete?`,
      );
      if (!proceed) return;
      try {
        await apiClient.post(`/api/v1/admin/grc/onboarding/${row.id}/complete`);
        addToast({ variant: 'success', message: 'Onboarding marked complete.' });
        void load();
      } catch (err) {
        addToast({
          variant: 'error',
          message: err instanceof Error ? err.message : 'Failed to mark complete.',
        });
      }
    },
    [addToast, load],
  );

  const rows = state.kind === 'ready' ? state.payload!.data : [];
  const total = state.kind === 'ready' ? state.payload!.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="mx-auto max-w-6xl p-4" data-testid="onb-register-page">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">HR Onboarding Register</h1>
          <p className="text-sm font-body text-deep-charcoal/70">
            New-hire provisioning tracker with SLA deadlines. GRC-Lite Wave 4.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Status
            <select
              data-testid="onb-status-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as OnboardingStatusFilter);
                setPage(1);
              }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="pending">Pending</option>
              <option value="completed">Complete</option>
              <option value="all">All</option>
            </select>
          </label>
          {isAdmin && (
            <button
              type="button"
              data-testid="add-onb-button"
              onClick={() => setAddOpen(true)}
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              + Add onboarding
            </button>
          )}
        </div>
      </header>

      {state.kind === 'loading' && (
        <p data-testid="onb-loading" className="text-sm text-deep-charcoal/70">Loading…</p>
      )}
      {state.kind === 'error' && (
        <p role="alert" data-testid="onb-error" className="text-sm text-error-crimson">
          {state.message}
        </p>
      )}
      {state.kind === 'denied' && (
        <p role="alert" data-testid="onb-denied" className="text-sm text-error-crimson">
          You don&apos;t have permission to view this page.
        </p>
      )}

      {state.kind === 'ready' && (
        <>
          <OnboardingTable rows={rows} isAdmin={isAdmin} onComplete={(row) => void onComplete(row)} />
          <div className="mt-3 flex flex-col gap-2 text-sm font-body text-deep-charcoal/80 sm:flex-row sm:items-center sm:justify-between">
            <span data-testid="onb-total">
              {total} {total === 1 ? 'record' : 'records'}
            </span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                Per page
                <select
                  data-testid="onb-page-size"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(parseInt(e.target.value, 10) as PageSizeOption);
                    setPage(1);
                  }}
                  className="rounded border border-deep-charcoal/20 p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                data-testid="onb-prev-page"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40"
              >
                Prev
              </button>
              <span data-testid="onb-page-indicator">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                data-testid="onb-next-page"
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

      {isAdmin && addOpen && (
        <AddOnboardingModal onClose={() => setAddOpen(false)} onCreated={onCreated} />
      )}
    </section>
  );
}

export default OnboardingRegister;
