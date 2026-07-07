// Authorized by HUB-1737 (E-V2-PP-2 S8, HUB-1726, HUB-1701) — Quote creation form at
// /console/billing/quotes/new. Tenant picker + product picker + line-item table + expiry
// date. Running total updates live. Submit calls POST /api/v1/admin/billing/quotes.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../lib/api';

interface DraftLineItem {
  description: string;
  quantity: string; // held as string in-form for controlled inputs
  unit_amount_cents: string;
}

const INITIAL_LINE_ITEM: DraftLineItem = {
  description: '',
  quantity: '1',
  unit_amount_cents: '',
};

export interface NewCustomQuoteProps {
  /** Tenant to create the quote for. Required. */
  tenantId: string;
  /** Product to bind the quote to. Required. */
  productId: string;
}

function toIntSafe(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * Validate a draft form. Returns per-field error map; empty = valid.
 */
export function validateNewQuote(
  lineItems: DraftLineItem[],
  expiresAt: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (lineItems.length === 0) {
    errors['line_items'] = 'At least one line item is required.';
  }
  lineItems.forEach((li, i) => {
    if (li.description.trim().length === 0) {
      errors[`line_items[${i}].description`] = 'Description is required.';
    }
    if (toIntSafe(li.quantity) < 1) {
      errors[`line_items[${i}].quantity`] = 'Quantity must be ≥ 1.';
    }
    if (toIntSafe(li.unit_amount_cents) < 0) {
      errors[`line_items[${i}].unit_amount_cents`] = 'Unit amount must be non-negative.';
    }
  });
  if (expiresAt.length > 0 && new Date(expiresAt).getTime() < Date.now()) {
    errors['expires_at'] = 'Expiration must be in the future (or leave blank for default 30 days).';
  }
  return errors;
}

export function NewCustomQuote({ tenantId, productId }: NewCustomQuoteProps): React.ReactElement {
  const navigate = useNavigate();
  const [lineItems, setLineItems] = useState<DraftLineItem[]>([{ ...INITIAL_LINE_ITEM }]);
  const [expiresAt, setExpiresAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const errors = useMemo(() => validateNewQuote(lineItems, expiresAt), [lineItems, expiresAt]);
  const runningTotal = useMemo(
    () => lineItems.reduce((sum, li) => sum + toIntSafe(li.quantity) * toIntSafe(li.unit_amount_cents), 0),
    [lineItems],
  );

  const addRow = (): void => setLineItems([...lineItems, { ...INITIAL_LINE_ITEM }]);
  const removeRow = (idx: number): void => setLineItems(lineItems.filter((_, i) => i !== idx));
  const updateRow = (idx: number, patch: Partial<DraftLineItem>): void => {
    setLineItems(lineItems.map((li, i) => (i === idx ? { ...li, ...patch } : li)));
  };

  const canSubmit = Object.keys(errors).length === 0 && !submitting;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const payload = {
        tenant_id: tenantId,
        product_id: productId,
        line_items: lineItems.map((li) => ({
          description: li.description,
          quantity: toIntSafe(li.quantity),
          unit_amount_cents: toIntSafe(li.unit_amount_cents),
        })),
        ...(expiresAt.length > 0 ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      };
      const res = await apiClient.post<{ id: string }>('/api/v1/admin/billing/quotes', payload);
      navigate(`/console/billing/quotes/${res.id}`);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mx-auto max-w-3xl p-4" data-testid="new-quote-page">
      <header className="mb-4">
        <h1 className="font-heading text-2xl text-primary-navy">New custom quote</h1>
        <p className="text-sm font-body text-deep-charcoal/70">
          Draft a quote for this tenant + product. Two-role approval required before invoicing —
          you cannot approve your own quote.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        <div className="rounded border border-deep-charcoal/15 p-3">
          <span className="text-sm font-body text-deep-charcoal/80">Line items</span>
          <table className="mt-2 w-full text-sm font-body">
            <thead>
              <tr className="text-left text-deep-charcoal/70 text-xs">
                <th scope="col" className="pb-1 pr-2">Description</th>
                <th scope="col" className="pb-1 pr-2">Qty</th>
                <th scope="col" className="pb-1 pr-2">Unit ($)</th>
                <th scope="col" className="pb-1 pr-2">Line total</th>
                <th scope="col" className="pb-1 pr-2" aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li, idx) => {
                const lineTotal = toIntSafe(li.quantity) * toIntSafe(li.unit_amount_cents);
                return (
                  <tr key={idx}>
                    <td className="pr-2 py-1">
                      <input
                        data-testid={`quote-line-desc-${idx}`}
                        type="text"
                        value={li.description}
                        onChange={(e) => updateRow(idx, { description: e.target.value })}
                        className="w-full rounded border border-deep-charcoal/20 p-1 text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      />
                    </td>
                    <td className="pr-2 py-1">
                      <input
                        data-testid={`quote-line-qty-${idx}`}
                        type="number"
                        min={1}
                        value={li.quantity}
                        onChange={(e) => updateRow(idx, { quantity: e.target.value })}
                        className="w-16 rounded border border-deep-charcoal/20 p-1 text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      />
                    </td>
                    <td className="pr-2 py-1">
                      <input
                        data-testid={`quote-line-amount-${idx}`}
                        type="number"
                        min={0}
                        value={li.unit_amount_cents}
                        onChange={(e) => updateRow(idx, { unit_amount_cents: e.target.value })}
                        placeholder="cents"
                        className="w-24 rounded border border-deep-charcoal/20 p-1 text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      />
                    </td>
                    <td className="pr-2 py-1 text-deep-charcoal">{formatCurrency(lineTotal)}</td>
                    <td className="pr-2 py-1">
                      {lineItems.length > 1 && (
                        <button
                          type="button"
                          data-testid={`quote-line-remove-${idx}`}
                          onClick={() => removeRow(idx)}
                          aria-label={`Remove line ${idx + 1}`}
                          className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5"
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            type="button"
            data-testid="quote-add-line"
            onClick={addRow}
            className="mt-2 rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5"
          >
            + Add line
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
          Expires at (blank = default 30 days)
          <input
            data-testid="quote-expires-at"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
          />
          {errors['expires_at'] && (
            <span role="alert" className="text-xs text-error-crimson">
              {errors['expires_at']}
            </span>
          )}
        </label>

        <div
          data-testid="quote-running-total"
          className="rounded border border-deep-charcoal/15 p-3 text-sm font-body text-primary-navy"
        >
          Total: <strong>{formatCurrency(runningTotal)}</strong>
        </div>

        {serverError && (
          <div
            role="alert"
            data-testid="quote-server-error"
            className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {serverError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="quote-cancel"
            onClick={() => navigate('/console/billing/quotes')}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="quote-submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create draft'}
          </button>
        </div>
      </div>
    </section>
  );
}

export default NewCustomQuote;
