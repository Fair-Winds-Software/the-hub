// Authorized by HUB-1755 + HUB-1756 + HUB-1757 (E-V2-PP-4 S6/S7/S8, HUB-1728, HUB-1701) —
// Three co-located components:
//   - UpgradeBanner (S6): dismissible upgrade suggestion banner
//   - GrandfatherEditor (S7): operator-side per-tenant grandfather CRUD
//   - RenewalPreview (S8): side-by-side current / grandfathered / standard renewal price

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api';

const formatCurrency = (cents: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

// ─── S6: UpgradeBanner ─────────────────────────────────────────────────────

export interface UpgradeSuggestion {
  id: string;
  tenant_id: string;
  product_id: string;
  suggested_tier_index: number;
  projected_savings_cents: number;
}

interface UpgradeBannerProps {
  tenantId: string;
  productId: string;
}

export function UpgradeBanner({ tenantId, productId }: UpgradeBannerProps): React.ReactElement | null {
  const [suggestion, setSuggestion] = useState<UpgradeSuggestion | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await apiClient.get<{ suggestion: UpgradeSuggestion | null }>(
        `/api/v1/tenants/${tenantId}/products/${productId}/upgrade-suggestion`,
      );
      setSuggestion(res.suggestion);
    } catch {
      setSuggestion(null);
    }
  }, [tenantId, productId]);

  useEffect(() => { void load(); }, [load]);

  const handleDismiss = async (): Promise<void> => {
    setDismissing(true);
    try {
      await apiClient.post(
        `/api/v1/tenants/${tenantId}/products/${productId}/upgrade-suggestion/dismiss`,
        {},
      );
      setSuggestion(null);
    } finally {
      setDismissing(false);
    }
  };

  if (suggestion === null) return null;

  const savings = suggestion.projected_savings_cents;
  const copyPositive = savings > 0
    ? `You'd save ${formatCurrency(savings)}/month by upgrading to a higher tier.`
    : `Consider upgrading for higher limits.`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="upgrade-banner"
      className="rounded border border-primary-navy/30 bg-primary-navy/5 p-3 flex items-center justify-between"
    >
      <div className="text-sm font-body text-primary-navy">
        <strong>Usage suggests Tier {suggestion.suggested_tier_index + 1}.</strong> {copyPositive}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="upgrade-review"
          className="rounded bg-primary-navy px-3 py-1.5 text-xs font-body text-sailcloth hover:bg-primary-navy/90"
        >
          Review upgrade
        </button>
        <button
          type="button"
          aria-label="Dismiss upgrade suggestion"
          data-testid="upgrade-dismiss"
          disabled={dismissing}
          onClick={() => void handleDismiss()}
          className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 disabled:opacity-50"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ─── S7: GrandfatherEditor (operator-side) ─────────────────────────────────

export interface GrandfatherRow {
  id: string;
  tenant_id: string;
  product_id: string;
  policy_type: 'year1_migration_lock' | '12_month_lock' | 'custom';
  delta_cents: number;
  effective_from: string;
  expires_at: string;
  terms: string;
}

interface NewGrandfatherDraft {
  product_id: string;
  policy_type: GrandfatherRow['policy_type'];
  delta_cents: string;
  effective_from: string;
  expires_at: string;
  terms: string;
}

const INITIAL_DRAFT: NewGrandfatherDraft = {
  product_id: '',
  policy_type: 'custom',
  delta_cents: '',
  effective_from: '',
  expires_at: '',
  terms: '',
};

export function validateGrandfather(draft: NewGrandfatherDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.product_id) errors['product_id'] = 'Product is required.';
  const delta = parseInt(draft.delta_cents, 10);
  if (Number.isNaN(delta) || delta === 0) {
    errors['delta_cents'] = 'Delta must be a non-zero integer (positive or negative cents).';
  }
  if (!draft.effective_from) errors['effective_from'] = 'Effective-from date is required.';
  if (!draft.expires_at) errors['expires_at'] = 'Expiration date is required.';
  if (draft.effective_from && draft.expires_at) {
    if (new Date(draft.expires_at).getTime() <= new Date(draft.effective_from).getTime()) {
      errors['expires_at'] = 'Expiration must be after effective-from date.';
    }
  }
  if (draft.terms.trim().length < 20) {
    errors['terms'] = 'Terms must be at least 20 characters (audit compliance).';
  }
  return errors;
}

interface GrandfatherEditorProps {
  tenantId: string;
  productOptions: Array<{ id: string; name: string }>;
}

export function GrandfatherEditor({
  tenantId,
  productOptions,
}: GrandfatherEditorProps): React.ReactElement {
  const [rows, setRows] = useState<GrandfatherRow[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<NewGrandfatherDraft>(INITIAL_DRAFT);
  const errors = useMemo(() => validateGrandfather(draft), [draft]);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await apiClient.get<{ data: GrandfatherRow[] }>(
        `/api/v1/admin/tenants/${tenantId}/grandfathers`,
      );
      setRows(res.data);
    } catch {
      setRows([]);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (): Promise<void> => {
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    try {
      await apiClient.post(`/api/v1/admin/tenants/${tenantId}/grandfathers`, {
        product_id: draft.product_id,
        policy_type: draft.policy_type,
        delta_cents: parseInt(draft.delta_cents, 10),
        effective_from: draft.effective_from,
        expires_at: draft.expires_at,
        terms: draft.terms,
      });
      setModalOpen(false);
      setDraft(INITIAL_DRAFT);
      void load();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="p-4" data-testid="grandfather-editor">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="font-heading text-lg text-primary-navy">Grandfather policies</h2>
        <button
          type="button"
          data-testid="grandfather-new-button"
          onClick={() => setModalOpen(true)}
          className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90"
        >
          + New grandfather
        </button>
      </header>
      {rows.length === 0 && (
        <p data-testid="grandfather-empty" className="text-xs text-deep-charcoal/60">
          No grandfather policies for this tenant.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid={`grandfather-row-${r.id}`}
              className="rounded border border-deep-charcoal/15 p-2 text-xs font-body"
            >
              <div className="flex items-center justify-between">
                <span className="text-primary-navy">
                  {r.policy_type} · <strong>{formatCurrency(r.delta_cents)}</strong> delta
                </span>
                <span className="text-deep-charcoal/70">
                  {r.effective_from.slice(0, 10)} → {r.expires_at.slice(0, 10)}
                </span>
              </div>
              <p className="mt-1 text-deep-charcoal/80">{r.terms}</p>
            </li>
          ))}
        </ul>
      )}

      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="grandfather-modal"
          className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
        >
          <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
            <h3 className="mb-2 font-heading text-lg text-primary-navy">New grandfather</h3>
            <div className="flex flex-col gap-2 text-xs font-body">
              <label>
                Product
                <select
                  data-testid="grandfather-product"
                  value={draft.product_id}
                  onChange={(e) => setDraft({ ...draft, product_id: e.target.value })}
                  className="mt-1 w-full rounded border border-deep-charcoal/20 p-1.5 text-primary-navy"
                >
                  <option value="">— Select product —</option>
                  {productOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label>
                Policy type
                <select
                  data-testid="grandfather-policy-type"
                  value={draft.policy_type}
                  onChange={(e) => setDraft({ ...draft, policy_type: e.target.value as GrandfatherRow['policy_type'] })}
                  className="mt-1 w-full rounded border border-deep-charcoal/20 p-1.5 text-primary-navy"
                >
                  <option value="year1_migration_lock">Year 1 migration lock</option>
                  <option value="12_month_lock">12 month lock</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label>
                Delta cents (positive = surcharge, negative = discount)
                <input
                  data-testid="grandfather-delta"
                  type="number"
                  value={draft.delta_cents}
                  onChange={(e) => setDraft({ ...draft, delta_cents: e.target.value })}
                  className="mt-1 w-full rounded border border-deep-charcoal/20 p-1.5 text-primary-navy"
                />
                {errors['delta_cents'] && (
                  <span role="alert" className="text-error-crimson">{errors['delta_cents']}</span>
                )}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label>
                  Effective from
                  <input
                    data-testid="grandfather-effective-from"
                    type="date"
                    value={draft.effective_from}
                    onChange={(e) => setDraft({ ...draft, effective_from: e.target.value })}
                    className="mt-1 w-full rounded border border-deep-charcoal/20 p-1.5 text-primary-navy"
                  />
                </label>
                <label>
                  Expires at
                  <input
                    data-testid="grandfather-expires-at"
                    type="date"
                    value={draft.expires_at}
                    onChange={(e) => setDraft({ ...draft, expires_at: e.target.value })}
                    className="mt-1 w-full rounded border border-deep-charcoal/20 p-1.5 text-primary-navy"
                  />
                </label>
              </div>
              {errors['expires_at'] && (
                <span role="alert" className="text-error-crimson">{errors['expires_at']}</span>
              )}
              <label>
                Terms (≥ 20 chars — audit compliance)
                <textarea
                  data-testid="grandfather-terms"
                  rows={3}
                  value={draft.terms}
                  onChange={(e) => setDraft({ ...draft, terms: e.target.value })}
                  className="mt-1 w-full rounded border border-deep-charcoal/20 p-1.5 text-primary-navy"
                />
                {errors['terms'] && (
                  <span role="alert" className="text-error-crimson">{errors['terms']}</span>
                )}
              </label>
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="grandfather-cancel"
                onClick={() => { setModalOpen(false); setDraft(INITIAL_DRAFT); }}
                className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="grandfather-submit"
                disabled={Object.keys(errors).length > 0 || submitting}
                onClick={() => void handleCreate()}
                className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:opacity-50"
              >
                {submitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── S8: RenewalPreview ───────────────────────────────────────────────────

export interface RenewalPriceResult {
  base_price_cents: number;
  grandfather_delta_cents: number;
  effective_price_cents: number;
  applied_grandfather_id: string | null;
}

interface RenewalPreviewProps {
  productName: string;
  data: RenewalPriceResult;
}

export function RenewalPreview({ productName, data }: RenewalPreviewProps): React.ReactElement {
  const hasGrandfather = data.applied_grandfather_id !== null;
  const savings = data.base_price_cents - data.effective_price_cents;
  return (
    <div
      className="rounded border border-deep-charcoal/15 p-3"
      data-testid={`renewal-preview-${productName.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <h3 className="mb-2 font-heading text-sm text-primary-navy">{productName}</h3>
      <dl className="grid grid-cols-2 gap-1 text-xs font-body">
        <dt className="text-deep-charcoal/70">Standard renewal:</dt>
        <dd className="text-deep-charcoal">{formatCurrency(data.base_price_cents)}</dd>
        {hasGrandfather && (
          <>
            <dt className="text-deep-charcoal/70">Grandfathered:</dt>
            <dd
              data-testid="renewal-preview-effective"
              className="text-primary-navy font-semibold"
            >
              {formatCurrency(data.effective_price_cents)}
            </dd>
            <dt className="text-deep-charcoal/70">
              {savings > 0 ? 'Grandfather saves tenant:' : 'Grandfather adds surcharge:'}
            </dt>
            <dd
              data-testid="renewal-preview-delta"
              className={savings > 0 ? 'text-success-forest' : 'text-error-crimson'}
            >
              {formatCurrency(Math.abs(savings))}/period
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
