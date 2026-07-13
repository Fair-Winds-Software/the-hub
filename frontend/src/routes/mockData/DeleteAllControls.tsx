// Authorized by HUB-1801 (S5 of HUB-1784) — DeleteAllControls slot for the MockData
// admin panel. Renders a section with a danger button and a description; the button
// opens a ConfirmDestructive dialog whose body lists the pre-delete row counts pulled
// from the current snapshot. Confirm fires DELETE /seed and refreshes the panel.
//
// The confirm dialog requires typing the phrase "DELETE" (case-sensitive) so operators
// cannot accidentally wipe the mock store with a single click.
import { useCallback, useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';
import { ConfirmDestructive } from '../../components/ConfirmDestructive';
import { useToastStore } from '../../stores/toastStore';

const DELETE_PATH = '/api/v1/admin/connections/stripe/seed';

interface DeleteResponse {
  rows_deleted: number;
}

export interface DeleteAllControlsProps {
  snapshot: Record<string, number>;
  refresh: () => void;
  /** For tests — override the DELETE request. */
  onDelete?: () => Promise<DeleteResponse>;
}

function snapshotIsEmpty(s: Record<string, number>): boolean {
  return Object.values(s).every((n) => n === 0);
}

function summarize(s: Record<string, number>): string {
  const parts = Object.entries(s)
    .filter(([, n]) => n > 0)
    .map(([facet, n]) => `${n} ${facet}`);
  if (parts.length === 0) return 'nothing (mock store is already empty)';
  return parts.join(', ');
}

export function DeleteAllControls({
  snapshot,
  refresh,
  onDelete,
}: DeleteAllControlsProps): React.ReactElement {
  const addToast = useToastStore((s) => s.addToast);
  const [error, setError] = useState<string | null>(null);

  const effectiveDelete = useMemo(
    () => onDelete ?? (() => apiClient.delete<DeleteResponse>(DELETE_PATH)),
    [onDelete],
  );

  const isEmpty = snapshotIsEmpty(snapshot);

  const runDelete = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const res = await effectiveDelete();
      addToast({
        variant: 'success',
        message: `Deleted ${res.rows_deleted} mock row${res.rows_deleted === 1 ? '' : 's'}.`,
      });
      refresh();
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      throw e;
    }
  }, [effectiveDelete, addToast, refresh]);

  return (
    <section
      data-testid="mock-data-delete-controls"
      aria-label="Delete all test data"
      className="rounded-md border border-red-300 bg-red-50/40 p-4"
    >
      <h2 className="mb-1 font-heading text-lg text-red-900">Delete all test data</h2>
      <p className="mb-3 text-sm text-deep-charcoal/70">
        Wipes every row from the mock store. The backend mock-only guard still applies —
        this call is rejected if Stripe is in LIVE mode.
      </p>

      <ConfirmDestructive
        title="Delete all mock rows?"
        body={`This will delete ${summarize(snapshot)}. This cannot be undone.`}
        confirmLabel="Yes, delete everything"
        requirePhrase="DELETE"
        onConfirm={runDelete}
        trigger={(open) => (
          <button
            type="button"
            data-testid="delete-all-button"
            disabled={isEmpty}
            onClick={open}
            className="rounded-md border border-red-600 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Delete all test data
          </button>
        )}
      />

      {error ? (
        <p role="alert" data-testid="delete-error" className="mt-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </section>
  );
}
