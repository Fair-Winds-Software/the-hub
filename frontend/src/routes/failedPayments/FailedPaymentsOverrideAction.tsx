// Authorized by HUB-1691 (E-FE-13 S6) — "Mark as overridden" action.
// Modal collects a reason ≥20 chars (matching the BE 422 threshold from
// HUB-1686) + two-step confirm, then POSTs to /:id/override. Reason
// count updates live so the operator sees the gate.
//
// Never-delete invariant (Ironclad #1): the row stays visible in the
// list with a distinct 'overridden' badge after the action.
import { useState } from 'react';
import { apiClient } from '../../lib/api';
import { ApiError } from '../../lib/errors';

const OVERRIDE_PATH = '/api/v1/admin/billing/failed-payments';
const REASON_MIN_CHARS = 20;

interface FailedPaymentsOverrideActionProps {
  invoiceRowId: string;
  onOverrideSuccess: () => void;
}

type ModalState =
  | { kind: 'closed' }
  | { kind: 'open'; reason: string; pending: boolean; error: string | null };

export function FailedPaymentsOverrideAction({
  invoiceRowId,
  onOverrideSuccess,
}: FailedPaymentsOverrideActionProps): React.ReactElement {
  const [modal, setModal] = useState<ModalState>({ kind: 'closed' });

  const open = (): void =>
    setModal({ kind: 'open', reason: '', pending: false, error: null });
  const close = (): void => setModal({ kind: 'closed' });

  const handleConfirm = async (): Promise<void> => {
    if (modal.kind !== 'open') return;
    if (modal.reason.trim().length < REASON_MIN_CHARS) {
      setModal({
        ...modal,
        error: `Reason must be at least ${REASON_MIN_CHARS} characters.`,
      });
      return;
    }
    setModal({ ...modal, pending: true, error: null });
    try {
      await apiClient.post(`${OVERRIDE_PATH}/${invoiceRowId}/override`, {
        reason: modal.reason.trim(),
      });
      close();
      onOverrideSuccess();
    } catch (err: unknown) {
      let message: string;
      if (err instanceof ApiError && err.status === 409) {
        message = 'This invoice has already been overridden.';
      } else if (err instanceof ApiError && err.status === 422) {
        message = `Reason must be at least ${REASON_MIN_CHARS} characters.`;
      } else {
        message = err instanceof Error ? err.message : 'Override failed';
      }
      setModal({ ...modal, pending: false, error: message });
    }
  };

  const reasonLength =
    modal.kind === 'open' ? modal.reason.trim().length : 0;
  const reasonOk = reasonLength >= REASON_MIN_CHARS;

  return (
    <>
      <button
        type="button"
        data-testid="failed-payments-override-trigger"
        onClick={open}
        className="rounded border border-ironwake/40 bg-transparent px-3 py-1.5 text-sm font-body text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        Mark as overridden
      </button>
      {modal.kind === 'open' && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="failed-payments-override-title"
          data-testid="failed-payments-override-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-primary-navy/50 p-4"
        >
          <div className="w-full max-w-[480px] rounded-lg bg-sailcloth p-6 shadow-xl">
            <h2
              id="failed-payments-override-title"
              className="mb-3 font-heading text-xl text-primary-navy"
            >
              Mark as overridden
            </h2>
            <p className="mb-3 text-sm font-body text-deep-charcoal">
              This flags the failure as written off (manual reconciliation).
              The row is never deleted — it stays visible with an "Overridden"
              badge, and this action is audit-logged with your operator id
              and the reason you provide.
            </p>
            <label
              htmlFor="failed-payments-override-reason"
              className="mb-1 block text-sm font-body text-deep-charcoal"
            >
              Reason (min {REASON_MIN_CHARS} chars)
            </label>
            <textarea
              id="failed-payments-override-reason"
              data-testid="failed-payments-override-reason"
              value={modal.reason}
              onChange={(e) =>
                setModal({ ...modal, reason: e.target.value, error: null })
              }
              disabled={modal.pending}
              rows={4}
              aria-describedby="failed-payments-override-reason-count"
              className="mb-1 block w-full rounded-md border border-deep-charcoal/30 px-3 py-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-navy"
            />
            <p
              id="failed-payments-override-reason-count"
              data-testid="failed-payments-override-reason-count"
              className={`mb-3 text-xs font-mono ${
                reasonOk ? 'text-seafoam' : 'text-deep-charcoal/60'
              }`}
            >
              {reasonLength} / {REASON_MIN_CHARS} minimum
            </p>
            {modal.error && (
              <p
                role="alert"
                data-testid="failed-payments-override-error"
                className="mb-3 rounded-md border border-ironwake/30 bg-ironwake/10 px-3 py-2 text-sm font-body text-ironwake"
              >
                {modal.error}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                data-testid="failed-payments-override-cancel"
                onClick={close}
                disabled={modal.pending}
                className="rounded-md border border-deep-charcoal/30 bg-sailcloth px-4 py-2 text-sm font-body text-deep-charcoal hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-primary-navy disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="failed-payments-override-confirm"
                onClick={() => void handleConfirm()}
                disabled={modal.pending || !reasonOk}
                className="rounded-md bg-ironwake px-4 py-2 text-sm font-body text-sailcloth hover:bg-ironwake/90 focus:outline-none focus:ring-2 focus:ring-ironwake disabled:cursor-not-allowed disabled:opacity-50"
              >
                {modal.pending ? 'Overriding…' : 'Confirm override'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
