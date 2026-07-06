// Authorized by HUB-1398 (E-CMP-WAVE4 S5) — HR Offboarding Register page.
// Structural mirror of DeviceRegister/OnboardingRegister. Auto-complete lives BE-side
// (HUB-1385 PUT /:id/checklist decides based on all-three-true + not-yet-completed);
// the FE just PUTs the toggled field, then refetches. When the response comes back
// with completed_at set for the first time, we surface the "auto-completed" toast.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { useRole } from '../stores/sessionStore';
import { useToastStore } from '../stores/toastStore';
import { OffboardingTable, type ChecklistField } from './offboardingRegister/OffboardingTable';
import { AddOffboardingModal } from './offboardingRegister/AddOffboardingModal';
import type {
  OffboardingListResponse,
  OffboardingRow,
  OffboardingStatusFilter,
} from './offboardingRegister/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

interface LoadState {
  kind: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  payload?: OffboardingListResponse;
  message?: string;
}

export function OffboardingRegister(): React.ReactElement {
  const role = useRole();
  const isAdmin = role === 'super_admin';
  const addToast = useToastStore((s) => s.addToast);

  const [statusFilter, setStatusFilter] = useState<OffboardingStatusFilter>('pending');
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
      const payload = await apiClient.get<OffboardingListResponse>(
        `/api/v1/admin/grc/offboarding?${params.toString()}`,
      );
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load offboarding records.',
      });
    }
  }, [statusFilter, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  const onCreated = useCallback((): void => {
    setAddOpen(false);
    void load();
  }, [load]);

  const onChecklistToggle = useCallback(
    async (row: OffboardingRow, field: ChecklistField, value: boolean): Promise<void> => {
      const wasCompleted = row.completed_at !== null;
      try {
        const updated = await apiClient.put<OffboardingRow>(
          `/api/v1/admin/grc/offboarding/${row.id}/checklist`,
          { [field]: value },
        );
        if (!wasCompleted && updated.completed_at !== null) {
          addToast({
            variant: 'success',
            message: 'Offboarding complete — access revocation confirmed.',
          });
        } else {
          addToast({ variant: 'success', message: 'Checklist updated.' });
        }
        void load();
      } catch (err) {
        addToast({
          variant: 'error',
          message: err instanceof Error ? err.message : 'Failed to update checklist.',
        });
      }
    },
    [addToast, load],
  );

  const rows = state.kind === 'ready' ? state.payload!.data : [];
  const total = state.kind === 'ready' ? state.payload!.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="mx-auto max-w-6xl p-4" data-testid="off-register-page">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">HR Offboarding Register</h1>
          <p className="text-sm font-body text-deep-charcoal/70">
            Departing-employee access revocation tracker with 24-hour deadline. GRC-Lite Wave 4.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Status
            <select
              data-testid="off-status-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as OffboardingStatusFilter);
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
              data-testid="add-off-button"
              onClick={() => setAddOpen(true)}
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              + Add offboarding
            </button>
          )}
        </div>
      </header>

      {state.kind === 'loading' && (
        <p data-testid="off-loading" className="text-sm text-deep-charcoal/70">Loading…</p>
      )}
      {state.kind === 'error' && (
        <p role="alert" data-testid="off-error" className="text-sm text-error-crimson">
          {state.message}
        </p>
      )}
      {state.kind === 'denied' && (
        <p role="alert" data-testid="off-denied" className="text-sm text-error-crimson">
          You don&apos;t have permission to view this page.
        </p>
      )}

      {state.kind === 'ready' && (
        <>
          <OffboardingTable
            rows={rows}
            isAdmin={isAdmin}
            onChecklistToggle={(row, field, value) => void onChecklistToggle(row, field, value)}
          />
          <div className="mt-3 flex flex-col gap-2 text-sm font-body text-deep-charcoal/80 sm:flex-row sm:items-center sm:justify-between">
            <span data-testid="off-total">
              {total} {total === 1 ? 'record' : 'records'}
            </span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                Per page
                <select
                  data-testid="off-page-size"
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
                data-testid="off-prev-page"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40"
              >
                Prev
              </button>
              <span data-testid="off-page-indicator">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                data-testid="off-next-page"
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
        <AddOffboardingModal onClose={() => setAddOpen(false)} onCreated={onCreated} />
      )}
    </section>
  );
}

export default OffboardingRegister;
