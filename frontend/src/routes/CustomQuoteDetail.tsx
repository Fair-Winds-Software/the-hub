// Authorized by HUB-1739 (E-V2-PP-2 S10, HUB-1726, HUB-1701) — Custom quote detail
// view at /console/billing/quotes/:id. Shows header, line items, approval history,
// and Approve/Reject buttons when caller is a super_admin AND caller.operator_id !=
// quote.operator_id (two-role attestation defense-in-depth over the API).

import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import type { QuoteRow } from './CustomQuotes';

interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  sort_order: number;
}

interface Approval {
  id: string;
  approver_operator_id: string;
  decision: 'approved' | 'rejected';
  reason: string;
  content_hash: string;
  created_at: string;
}

interface QuoteDetail extends QuoteRow {
  line_items: LineItem[];
  approvals: Approval[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; quote: QuoteDetail };

type Decision = 'approve' | 'reject';

export interface CustomQuoteDetailProps {
  /** operator_id of the current caller, so we can hide approve/reject buttons for
      self-approve attempts (defense-in-depth over the API 403). */
  currentOperatorId: string;
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function CustomQuoteDetail({ currentOperatorId }: CustomQuoteDetailProps): React.ReactElement {
  const { id: quoteId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [decisionModal, setDecisionModal] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const q = await apiClient.get<QuoteDetail>(`/api/v1/admin/billing/quotes/${quoteId}`);
      setState({ kind: 'ready', quote: q });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load quote.' });
    }
  }, [quoteId]);

  useEffect(() => { void load(); }, [load]);

  const handleDecisionSubmit = async (): Promise<void> => {
    if (decisionModal === null) return;
    if (reason.trim().length < 20) {
      setDecisionError('Reason must be at least 20 characters.');
      return;
    }
    setSubmitting(true);
    setDecisionError(null);
    try {
      await apiClient.post(
        `/api/v1/admin/billing/quotes/${quoteId}/${decisionModal}`,
        { reason },
      );
      setDecisionModal(null);
      setReason('');
      void load();
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : 'Decision failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <section className="mx-auto max-w-3xl p-4">
        <p data-testid="quote-detail-loading" className="text-sm text-deep-charcoal/70">Loading…</p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="mx-auto max-w-3xl p-4">
        <p role="alert" data-testid="quote-detail-error" className="text-sm text-error-crimson">
          {state.message}
        </p>
      </section>
    );
  }
  if (state.kind === 'denied') {
    return (
      <section className="mx-auto max-w-3xl p-4">
        <p role="alert" data-testid="quote-detail-denied" className="text-sm text-error-crimson">
          You don&apos;t have permission to view this quote.
        </p>
      </section>
    );
  }

  const q = state.quote;
  // AC 2 visibility: hide approve/reject buttons for the creator (defense over API 403).
  const isCreator = q.operator_id === currentOperatorId;
  const canDecide = !isCreator && (q.status === 'draft' || q.status === 'pending');

  return (
    <section className="mx-auto max-w-3xl p-4" data-testid="quote-detail-page">
      <header className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">
            Custom quote — {formatCurrency(q.total_cents)}
          </h1>
          <p className="text-sm font-body text-deep-charcoal/70">
            Status: <strong>{q.status}</strong> · Created {q.created_at.slice(0, 10)} · Expires {q.expires_at.slice(0, 10)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/console/billing/quotes')}
          className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5"
        >
          ← Back to list
        </button>
      </header>

      <section className="mb-4 rounded border border-deep-charcoal/15 p-3">
        <h2 className="mb-2 font-heading text-sm text-primary-navy">Line items</h2>
        <table className="w-full text-sm font-body">
          <thead>
            <tr className="text-left text-deep-charcoal/70 text-xs">
              <th className="pb-1 pr-2">Description</th>
              <th className="pb-1 pr-2">Qty</th>
              <th className="pb-1 pr-2">Unit</th>
              <th className="pb-1 pr-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {q.line_items.map((li) => (
              <tr key={li.id} data-testid={`quote-line-${li.id}`}>
                <td className="py-1 pr-2 text-deep-charcoal">{li.description}</td>
                <td className="py-1 pr-2 text-deep-charcoal">{li.quantity}</td>
                <td className="py-1 pr-2 text-deep-charcoal">{formatCurrency(li.unit_amount_cents)}</td>
                <td className="py-1 pr-2 text-deep-charcoal">
                  {formatCurrency(li.unit_amount_cents * li.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-4 rounded border border-deep-charcoal/15 p-3">
        <h2 className="mb-2 font-heading text-sm text-primary-navy">Approval history</h2>
        {q.approvals.length === 0 ? (
          <p data-testid="approvals-empty" className="text-xs text-deep-charcoal/60">
            No approvals yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {q.approvals.map((a) => (
              <li
                key={a.id}
                data-testid={`approval-row-${a.id}`}
                className="rounded border border-deep-charcoal/10 p-2 text-xs font-body"
              >
                <div className="flex items-center justify-between text-deep-charcoal">
                  <span><strong>{a.decision}</strong> by {a.approver_operator_id}</span>
                  <span className="text-deep-charcoal/60">{a.created_at.slice(0, 10)}</span>
                </div>
                <p className="mt-1 text-deep-charcoal/80">{a.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canDecide && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="quote-reject-button"
            onClick={() => { setDecisionModal('reject'); setDecisionError(null); }}
            className="rounded border border-error-crimson px-3 py-1.5 text-sm font-body text-error-crimson hover:bg-error-crimson/5"
          >
            Reject
          </button>
          <button
            type="button"
            data-testid="quote-approve-button"
            onClick={() => { setDecisionModal('approve'); setDecisionError(null); }}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90"
          >
            Approve
          </button>
        </div>
      )}
      {isCreator && (q.status === 'draft' || q.status === 'pending') && (
        <p data-testid="quote-self-notice" className="text-xs text-deep-charcoal/60">
          You created this quote — a different operator must approve or reject it (two-role attestation).
        </p>
      )}

      {decisionModal !== null && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="decision-modal"
          className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
        >
          <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
            <h3 className="mb-2 font-heading text-lg text-primary-navy">
              {decisionModal === 'approve' ? 'Approve quote' : 'Reject quote'}
            </h3>
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Reason (≥ 20 characters — audit trail)
              <textarea
                data-testid="decision-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              />
              <span className="text-xs text-deep-charcoal/60">{reason.length} / 20 chars minimum</span>
            </label>
            {decisionError && (
              <div
                role="alert"
                data-testid="decision-error"
                className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
              >
                {decisionError}
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="decision-cancel"
                onClick={() => { setDecisionModal(null); setReason(''); }}
                className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="decision-submit"
                onClick={() => void handleDecisionSubmit()}
                disabled={submitting || reason.trim().length < 20}
                className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Submitting…' : (decisionModal === 'approve' ? 'Approve' : 'Reject')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default CustomQuoteDetail;
