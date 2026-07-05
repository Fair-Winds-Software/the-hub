// Authorized by HUB-1396 (E-CMP-WAVE4 S3) — GRC-Lite Device Compliance Register page.
// Shell: header (title + status filter + Add Device button, super_admin-gated) + table
// + pagination controls. Add/Attest modals are inline-mounted; Decommission uses the
// browser's native confirm (satisfies the "confirmation dialog shown" AC without a
// second bespoke Dialog component). Both roles view the table; per-row actions +
// header controls hide for product_admin per AC 9.
//
// Data flow is plain useState + apiClient — the HUB frontend does not use react-query
// (the story's mention of React Query is aspirational; matching codebase pattern here).
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { useRole } from '../stores/sessionStore';
import { useToastStore } from '../stores/toastStore';
import { DeviceTable } from './deviceRegister/DeviceTable';
import { AddDeviceModal } from './deviceRegister/AddDeviceModal';
import { AttestDeviceModal } from './deviceRegister/AttestDeviceModal';
import type { DeviceRow, DevicesListResponse, StatusFilter } from './deviceRegister/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

interface LoadState {
  kind: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  payload?: DevicesListResponse;
  message?: string;
}

export function DeviceRegister(): React.ReactElement {
  const role = useRole();
  const isAdmin = role === 'super_admin';
  const addToast = useToastStore((s) => s.addToast);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(50);

  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [addOpen, setAddOpen] = useState(false);
  const [attestTarget, setAttestTarget] = useState<DeviceRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const payload = await apiClient.get<DevicesListResponse>(
        `/api/v1/admin/grc/devices?${params.toString()}`,
      );
      setState({ kind: 'ready', payload });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load devices.',
      });
    }
  }, [statusFilter, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreated = useCallback((): void => {
    setAddOpen(false);
    void load();
  }, [load]);

  const onAttested = useCallback((): void => {
    setAttestTarget(null);
    void load();
  }, [load]);

  const onDecommission = useCallback(
    async (row: DeviceRow): Promise<void> => {
      const proceed = window.confirm(
        `Decommission ${row.device_name}? This soft-deletes the device — it cannot be reversed from this screen.`,
      );
      if (!proceed) return;
      try {
        await apiClient.delete(`/api/v1/admin/grc/devices/${row.id}`);
        addToast({ variant: 'success', message: 'Device decommissioned.' });
        void load();
      } catch (err) {
        addToast({
          variant: 'error',
          message: err instanceof Error ? err.message : 'Failed to decommission device.',
        });
      }
    },
    [addToast, load],
  );

  const rows = state.kind === 'ready' ? state.payload!.data : [];
  const total = state.kind === 'ready' ? state.payload!.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="mx-auto max-w-6xl p-4" data-testid="device-register-page">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">Device Compliance Register</h1>
          <p className="text-sm font-body text-deep-charcoal/70">
            Employee device inventory + MDM / disk-encryption / screen-lock attestations. GRC-Lite Wave 4.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            Status
            <select
              data-testid="device-status-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as StatusFilter);
                setPage(1);
              }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="active">Active</option>
              <option value="decommissioned">Decommissioned</option>
              <option value="all">All</option>
            </select>
          </label>
          {isAdmin && (
            <button
              type="button"
              data-testid="add-device-button"
              onClick={() => setAddOpen(true)}
              className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              + Add device
            </button>
          )}
        </div>
      </header>

      {state.kind === 'loading' && (
        <p data-testid="device-loading" className="text-sm text-deep-charcoal/70">Loading devices…</p>
      )}
      {state.kind === 'error' && (
        <p role="alert" data-testid="device-error" className="text-sm text-error-crimson">
          {state.message}
        </p>
      )}
      {state.kind === 'denied' && (
        <p role="alert" data-testid="device-denied" className="text-sm text-error-crimson">
          You don&apos;t have permission to view this page.
        </p>
      )}

      {state.kind === 'ready' && (
        <>
          <DeviceTable
            rows={rows}
            isAdmin={isAdmin}
            onAttest={setAttestTarget}
            onDecommission={(row) => void onDecommission(row)}
          />
          <div className="mt-3 flex flex-col gap-2 text-sm font-body text-deep-charcoal/80 sm:flex-row sm:items-center sm:justify-between">
            <span data-testid="device-total">
              {total} {total === 1 ? 'device' : 'devices'}
            </span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                Per page
                <select
                  data-testid="device-page-size"
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
                data-testid="device-prev-page"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-40"
              >
                Prev
              </button>
              <span data-testid="device-page-indicator">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                data-testid="device-next-page"
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
        <AddDeviceModal onClose={() => setAddOpen(false)} onCreated={onCreated} />
      )}
      {isAdmin && attestTarget && (
        <AttestDeviceModal
          device={attestTarget}
          onClose={() => setAttestTarget(null)}
          onAttested={onAttested}
        />
      )}
    </section>
  );
}

export default DeviceRegister;
