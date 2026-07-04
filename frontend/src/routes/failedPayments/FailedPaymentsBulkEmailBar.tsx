// Authorized by HUB-1692 (E-FE-13 S7) — bulk-action bar for selected
// rows. Only "Send retry email" at v0.1. super_admin only — product_admin
// doesn't see the button per BE 403 gate + this client-side belt for
// affordance clarity (spec §7 highest-impact-action rationale).
//
// Recipient preview modal lists the selected invoices before sending
// so operators can't accidentally mass-send. Partial-failure UX shows
// {sent, failed[]} breakdown from HUB-1686.
import { useState } from 'react';
import { apiClient } from '../../lib/api';
import { useRole } from '../../stores/sessionStore';
import { formatMultiCurrencyCents } from './failed-payments-formatters';
import type { FailedPaymentRow } from '../FailedPayments';

const BULK_EMAIL_PATH =
  '/api/v1/admin/billing/failed-payments/bulk-email';
const MAX_RECIPIENTS = 50;

interface FailedPaymentsBulkEmailBarProps {
  selectedRows: FailedPaymentRow[];
  onClearSelection: () => void;
  onSuccess: () => void;
}

type SendState =
  | { kind: 'idle' }
  | { kind: 'preview' }
  | { kind: 'sending' }
  | {
      kind: 'result';
      sent: number;
      failed: Array<{ id: string; error: string }>;
    };

export function FailedPaymentsBulkEmailBar({
  selectedRows,
  onClearSelection,
  onSuccess,
}: FailedPaymentsBulkEmailBarProps): React.ReactElement | null {
  const role = useRole();
  const [state, setState] = useState<SendState>({ kind: 'idle' });

  // Keep the surface mounted while a result is visible so the operator
  // still sees "Sent N. Failed M." after the selection is cleared by
  // onSuccess. When idle + no selection, return null (no chrome).
  if (selectedRows.length === 0 && state.kind !== 'result') return null;

  const isSuperAdmin = role === 'super_admin';
  const overCap = selectedRows.length > MAX_RECIPIENTS;

  const openPreview = (): void => setState({ kind: 'preview' });
  const closeAll = (): void => setState({ kind: 'idle' });

  const handleSend = async (): Promise<void> => {
    setState({ kind: 'sending' });
    try {
      const res = await apiClient.post<{
        sent: number;
        failed: Array<{ id: string; error: string }>;
      }>(BULK_EMAIL_PATH, {
        ids: selectedRows.map((r) => r.id),
      });
      setState({ kind: 'result', sent: res.sent, failed: res.failed });
      if (res.failed.length === 0) onSuccess();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Send failed';
      setState({
        kind: 'result',
        sent: 0,
        failed: selectedRows.map((r) => ({ id: r.id, error: message })),
      });
    }
  };

  return (
    <>
      <div
        data-testid="failed-payments-bulk-bar"
        role="region"
        aria-label={`${selectedRows.length} row${selectedRows.length === 1 ? '' : 's'} selected`}
        className="flex items-center justify-between gap-2 rounded-md border border-primary-navy/40 bg-primary-navy/5 p-2 text-sm font-body text-deep-charcoal"
      >
        <span data-testid="failed-payments-bulk-count">
          {selectedRows.length} selected
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="failed-payments-bulk-clear"
            onClick={onClearSelection}
            className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Clear
          </button>
          {isSuperAdmin && (
            <button
              type="button"
              data-testid="failed-payments-bulk-send"
              onClick={openPreview}
              disabled={overCap}
              className="rounded border border-primary-navy/40 bg-primary-navy px-3 py-1 text-xs font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Send retry email
            </button>
          )}
        </div>
      </div>
      {overCap && isSuperAdmin && (
        <p
          role="alert"
          data-testid="failed-payments-bulk-over-cap"
          className="text-xs font-body text-ironwake"
        >
          Bulk-email accepts at most {MAX_RECIPIENTS} recipients per call.
          Narrow the selection.
        </p>
      )}

      {state.kind === 'preview' && (
        <div
          role="alertdialog"
          aria-modal="true"
          data-testid="failed-payments-bulk-preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-primary-navy/50 p-4"
        >
          <div className="w-full max-w-[560px] rounded-lg bg-sailcloth p-6 shadow-xl">
            <h2 className="mb-3 font-heading text-xl text-primary-navy">
              Send retry email to {selectedRows.length} recipient
              {selectedRows.length === 1 ? '' : 's'}?
            </h2>
            <p className="mb-3 text-sm font-body text-deep-charcoal">
              A payment-retry email will be sent to each tenant&apos;s
              billing address using the standard template. This action is
              audit-logged.
            </p>
            <ul
              data-testid="failed-payments-bulk-preview-list"
              className="mb-3 max-h-64 overflow-y-auto rounded border border-deep-charcoal/15 bg-white p-2"
            >
              {selectedRows.map((r) => (
                <li
                  key={r.id}
                  data-testid={`failed-payments-bulk-preview-row-${r.id}`}
                  className="border-b border-deep-charcoal/10 py-1 text-xs font-body text-deep-charcoal last:border-b-0"
                >
                  {r.tenantName} —{' '}
                  {formatMultiCurrencyCents(r.amountCents, r.currency)}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                data-testid="failed-payments-bulk-cancel"
                onClick={closeAll}
                className="rounded-md border border-deep-charcoal/30 bg-sailcloth px-4 py-2 text-sm font-body text-deep-charcoal hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-primary-navy"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="failed-payments-bulk-confirm"
                onClick={() => void handleSend()}
                className="rounded-md bg-primary-navy px-4 py-2 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-primary-navy"
              >
                Confirm send
              </button>
            </div>
          </div>
        </div>
      )}

      {state.kind === 'sending' && (
        <div
          data-testid="failed-payments-bulk-sending"
          role="status"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-2 text-xs font-body text-deep-charcoal/70"
        >
          Sending emails…
        </div>
      )}

      {state.kind === 'result' && (
        <div
          role="status"
          data-testid="failed-payments-bulk-result"
          className={`rounded-md border p-3 text-sm font-body ${
            state.failed.length === 0
              ? 'border-seafoam/40 bg-seafoam/10 text-seafoam'
              : 'border-accent-brass/40 bg-accent-brass/10 text-deep-charcoal'
          }`}
        >
          <p className="font-medium">
            Sent {state.sent}. Failed {state.failed.length}.
          </p>
          {state.failed.length > 0 && (
            <ul
              data-testid="failed-payments-bulk-result-failures"
              className="mt-2 text-xs"
            >
              {state.failed.map((f) => (
                <li key={f.id} className="font-mono">
                  {f.id}: {f.error}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            data-testid="failed-payments-bulk-result-close"
            onClick={closeAll}
            className="mt-2 rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
