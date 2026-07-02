// Authorized by HUB-1657 (E-FE-5 S7) — Discount + Override management surface
// at /console/products/:productId/pricing/exceptions. Two tabs (Discounts,
// Overrides) sharing the same list/modal/archive pattern established by
// HUB-1655 PlansManager + HUB-1656 AddOnsManager. Consumes the pre-existing
// operatorConsole.ts routes verified soft-archive by HUB-1653.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Route path: /pricing/exceptions (single page with two tabs) instead
//      of separate /discounts + /overrides pages. Discounts and overrides
//      are both "pricing exceptions per tenant/product"; keeping them
//      co-located lets the operator toggle between them without navigating
//      away from context. The tab is URL-synced via ?tab=discounts|overrides.
//
//   2. Edit action: the BE has no PUT endpoint for discounts or overrides
//      (operatorConsole.ts:174 + :226 are POST-only). Spec asked for Edit;
//      at v0.1 the FE offers Archive + New as the two operations (the
//      operator "edits" a discount by archiving the old one and applying a
//      new one). Restore is similarly unavailable (no PUT to flip
//      active=true). Both are HUB-1545 tech debt candidates.
//
//   3. Tenant scoping: the discount/override endpoints require tenantId
//      in the URL. Under the D-HUB-SCOPE-035 single-tenant model, we
//      resolve tenantId via the HUB-1700 portfolio lookup (same pattern
//      as PlansManager). If v0.2 allows multiple tenants per product, the
//      route will add a tenant picker.
//
//   4. Currency formatting uses inline Intl.NumberFormat pending the
//      HUB-1659 (S9) shared helper.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';
import { AccessDeniedPage } from '../../components/AccessDeniedPage';
import { formatCurrency, formatDateAbsolute } from './pricing-formatters';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Pricing exceptions | HUB Console';

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
}
interface PortfolioResponse {
  data: PortfolioProduct[];
}

type Tab = 'discounts' | 'overrides';

interface DiscountRow {
  id: string;
  tenant_id: string;
  product_id: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: string;
  expiry_date: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
}

interface OverrideRow {
  id: string;
  tenant_id: string;
  product_id: string;
  metric_name: string;
  unit_price_cents: number;
  active: boolean;
  created_at: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | {
      kind: 'ready';
      product: PortfolioProduct;
      discounts: DiscountRow[];
      overrides: OverrideRow[];
    };

function discountDisplay(d: DiscountRow): string {
  if (d.discount_type === 'percentage') {
    return `${d.discount_value}%`;
  }
  const cents = parseInt(d.discount_value, 10);
  if (isNaN(cents)) return d.discount_value;
  return formatCurrency(cents);
}

function discountStatus(d: DiscountRow): 'active' | 'expired' | 'archived' {
  if (!d.active) return 'archived';
  if (d.expiry_date) {
    const t = new Date(d.expiry_date).getTime();
    if (!Number.isNaN(t) && t < Date.now()) return 'expired';
  }
  return 'active';
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const cls =
    status === 'active'
      ? 'bg-seafoam/15 text-seafoam'
      : status === 'expired'
        ? 'bg-accent-brass/15 text-accent-brass'
        : 'bg-deep-charcoal/10 text-deep-charcoal/70';
  return (
    <span
      data-testid={`exceptions-status-${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-body ${cls}`}
    >
      {status}
    </span>
  );
}

interface NewDiscountDraft {
  discount_type: 'percentage' | 'fixed';
  discount_value: string;
  expiry_date: string;
  notes: string;
}

const DEFAULT_DISCOUNT: NewDiscountDraft = {
  discount_type: 'percentage',
  discount_value: '',
  expiry_date: '',
  notes: '',
};

interface NewDiscountModalProps {
  tenantId: string;
  productId: string;
  onCancel: () => void;
  onCreated: () => void;
}

function NewDiscountModal({
  tenantId,
  productId,
  onCancel,
  onCreated,
}: NewDiscountModalProps): React.ReactElement {
  const [draft, setDraft] = useState<NewDiscountDraft>(DEFAULT_DISCOUNT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    const value = parseFloat(draft.discount_value);
    if (isNaN(value) || value <= 0) {
      nextErrors.discount_value = 'Value must be a positive number.';
    } else if (draft.discount_type === 'percentage' && value > 100) {
      nextErrors.discount_value = 'Percentage must be between 0 and 100.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await apiClient.post('/api/v1/admin/console/discounts', {
        tenant_id: tenantId,
        product_id: productId,
        discount_type: draft.discount_type,
        discount_value: value,
        expiry_date: draft.expiry_date.length > 0 ? draft.expiry_date : undefined,
        notes: draft.notes.length > 0 ? draft.notes : undefined,
      });
      onCreated();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-discount-heading"
      data-testid="new-discount-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="new-discount-heading"
          className="mb-3 font-heading text-lg text-primary-navy"
        >
          New discount
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Type
            <select
              data-testid="new-discount-type"
              value={draft.discount_type}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  discount_type: e.target.value as 'percentage' | 'fixed',
                })
              }
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="percentage">Percentage</option>
              <option value="fixed">Fixed (cents)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Value
            <input
              data-testid="new-discount-value"
              type="text"
              inputMode="decimal"
              value={draft.discount_value}
              onChange={(e) =>
                setDraft({ ...draft, discount_value: e.target.value })
              }
              aria-invalid={errors.discount_value ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.discount_value && (
              <span
                data-testid="new-discount-value-err"
                className="text-xs text-ironwake"
              >
                {errors.discount_value}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Expiry date (optional)
            <input
              data-testid="new-discount-expiry"
              type="date"
              value={draft.expiry_date}
              onChange={(e) => setDraft({ ...draft, expiry_date: e.target.value })}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Notes
            <textarea
              data-testid="new-discount-notes"
              value={draft.notes}
              rows={2}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="new-discount-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="new-discount-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="new-discount-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Creating…' : 'Create discount'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface NewOverrideDraft {
  metric_name: string;
  unit_price_cents: string;
}

const DEFAULT_OVERRIDE: NewOverrideDraft = { metric_name: '', unit_price_cents: '' };

interface NewOverrideModalProps {
  tenantId: string;
  productId: string;
  onCancel: () => void;
  onCreated: () => void;
}

function NewOverrideModal({
  tenantId,
  productId,
  onCancel,
  onCreated,
}: NewOverrideModalProps): React.ReactElement {
  const [draft, setDraft] = useState<NewOverrideDraft>(DEFAULT_OVERRIDE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!draft.metric_name.trim()) nextErrors.metric_name = 'Metric name is required.';
    const cents = parseInt(draft.unit_price_cents, 10);
    if (isNaN(cents) || cents < 0) {
      nextErrors.unit_price_cents = 'Unit price must be a non-negative integer (cents).';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await apiClient.post('/api/v1/admin/console/overrides', {
        tenant_id: tenantId,
        product_id: productId,
        metric_name: draft.metric_name.trim(),
        unit_price_cents: cents,
      });
      onCreated();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-override-heading"
      data-testid="new-override-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="new-override-heading"
          className="mb-3 font-heading text-lg text-primary-navy"
        >
          New pricing override
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Metric name
            <input
              data-testid="new-override-metric"
              type="text"
              value={draft.metric_name}
              onChange={(e) =>
                setDraft({ ...draft, metric_name: e.target.value })
              }
              aria-invalid={errors.metric_name ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.metric_name && (
              <span
                data-testid="new-override-metric-err"
                className="text-xs text-ironwake"
              >
                {errors.metric_name}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Unit price (cents)
            <input
              data-testid="new-override-unit-price"
              type="text"
              inputMode="numeric"
              value={draft.unit_price_cents}
              onChange={(e) =>
                setDraft({ ...draft, unit_price_cents: e.target.value })
              }
              aria-invalid={errors.unit_price_cents ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {draft.unit_price_cents && (
              <span className="text-xs text-deep-charcoal/60">
                = {formatCurrency(parseInt(draft.unit_price_cents, 10) || 0)}
              </span>
            )}
            {errors.unit_price_cents && (
              <span
                data-testid="new-override-unit-price-err"
                className="text-xs text-ironwake"
              >
                {errors.unit_price_cents}
              </span>
            )}
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="new-override-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="new-override-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="new-override-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Creating…' : 'Create override'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ArchiveDialogState {
  kind: 'discount' | 'override';
  id: string;
  label: string;
  submitting: boolean;
  errorMessage: string | null;
}

interface ArchiveDialogProps {
  state: ArchiveDialogState;
  onCancel: () => void;
  onConfirm: () => void;
}

function ArchiveDialog({
  state,
  onCancel,
  onConfirm,
}: ArchiveDialogProps): React.ReactElement {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="archive-exception-heading"
      data-testid="archive-exception-dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="archive-exception-heading"
          className="mb-2 font-heading text-lg text-primary-navy"
        >
          Archive {state.kind} — {state.label}
        </h2>
        <p className="text-sm font-body text-deep-charcoal">
          Archive this {state.kind}? It will be hidden from the active list but
          preserved for billing history + audit.
        </p>
        {state.errorMessage && (
          <div
            role="alert"
            data-testid="archive-exception-error"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {state.errorMessage}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="archive-exception-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="archive-exception-confirm"
            onClick={onConfirm}
            disabled={state.submitting}
            className="rounded bg-ironwake px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-ironwake/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {state.submitting ? 'Archiving…' : `Archive ${state.kind}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PricingExceptionsManager(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: Tab =
    searchParams.get('tab') === 'overrides' ? 'overrides' : 'discounts';
  const setTab = (tab: Tab): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', tab);
        return next;
      },
      { replace: true },
    );
  };

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogState | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const portfolio = await apiClient.get<PortfolioResponse>(PORTFOLIO_PATH);
      const product = portfolio.data.find((p) => p.productId === productId);
      if (!product) {
        setState({ kind: 'denied' });
        return;
      }
      const qs = includeArchived ? '?includeArchived=true' : '';
      const [discounts, overrides] = await Promise.all([
        apiClient
          .get<{ data: DiscountRow[] }>(
            `/api/v1/admin/console/discounts/${product.tenantId}/${productId}${qs}`,
          )
          .then((r) => r.data)
          .catch(() => []),
        apiClient
          .get<{ data: OverrideRow[] }>(
            `/api/v1/admin/console/overrides/${product.tenantId}/${productId}${qs}`,
          )
          .then((r) => r.data)
          .catch(() => []),
      ]);
      setState({ kind: 'ready', product, discounts, overrides });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to load pricing exceptions';
      setState({ kind: 'error', message });
    }
  }, [productId, includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleArchiveConfirm = useCallback(async (): Promise<void> => {
    if (!archiveDialog) return;
    setArchiveDialog({ ...archiveDialog, submitting: true, errorMessage: null });
    try {
      const path =
        archiveDialog.kind === 'discount'
          ? `/api/v1/admin/console/discounts/${archiveDialog.id}`
          : `/api/v1/admin/console/overrides/${archiveDialog.id}`;
      await apiClient.delete(path);
      setArchiveDialog(null);
      void load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Archive failed.';
      setArchiveDialog({ ...archiveDialog, errorMessage: message, submitting: false });
    }
  }, [archiveDialog, load]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="exceptions-manager-page"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="exceptions-manager-skeleton"
          className="h-64 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }
  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="this product's pricing exceptions"
          backTo="/console/products"
          backLabel="Back to products"
        />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="exceptions-manager-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load pricing exceptions.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="exceptions-manager-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      id="main-content"
      data-testid="exceptions-manager-page"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">
          Pricing exceptions — {state.product.productName}
        </h1>
        <Link
          to={`/console/products/${productId}`}
          className="w-fit text-xs font-body text-primary-navy underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          ← Back to product
        </Link>
      </header>

      <div role="tablist" className="flex items-center gap-1 border-b border-deep-charcoal/15">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'discounts'}
          data-testid="exceptions-tab-discounts"
          onClick={() => setTab('discounts')}
          className={
            activeTab === 'discounts'
              ? 'border-b-2 border-primary-navy px-3 py-1.5 text-sm font-body text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass'
              : 'px-3 py-1.5 text-sm font-body text-deep-charcoal/70 hover:text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass'
          }
        >
          Discounts ({state.discounts.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'overrides'}
          data-testid="exceptions-tab-overrides"
          onClick={() => setTab('overrides')}
          className={
            activeTab === 'overrides'
              ? 'border-b-2 border-primary-navy px-3 py-1.5 text-sm font-body text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass'
              : 'px-3 py-1.5 text-sm font-body text-deep-charcoal/70 hover:text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass'
          }
        >
          Overrides ({state.overrides.length})
        </button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
          <input
            type="checkbox"
            data-testid="exceptions-show-archived"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
        <button
          type="button"
          data-testid={
            activeTab === 'discounts'
              ? 'exceptions-new-discount'
              : 'exceptions-new-override'
          }
          onClick={() => setShowNew(true)}
          className="rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          {activeTab === 'discounts' ? 'New discount' : 'New override'}
        </button>
      </div>

      {activeTab === 'discounts' ? (
        state.discounts.length === 0 ? (
          <div
            data-testid="exceptions-discounts-empty"
            className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
          >
            No discounts on this product. Click <strong>New discount</strong> to
            add one.
          </div>
        ) : (
          <ul data-testid="exceptions-discounts-list" className="flex flex-col gap-2">
            {state.discounts.map((d) => {
              const status = discountStatus(d);
              return (
                <li
                  key={d.id}
                  data-testid={`exceptions-discount-row-${d.id}`}
                  className={
                    status === 'archived'
                      ? 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-deep-charcoal/5 p-3'
                      : 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-sailcloth p-3'
                  }
                >
                  <div>
                    <p className="font-heading text-base text-primary-navy">
                      {discountDisplay(d)}
                    </p>
                    <p className="text-xs font-body text-deep-charcoal/70">
                      Expires: {formatDateAbsolute(d.expiry_date)}
                    </p>
                    {d.notes && (
                      <p className="text-xs font-body text-deep-charcoal/60 italic">
                        {d.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={status} />
                    {status !== 'archived' && (
                      <button
                        type="button"
                        data-testid={`exceptions-discount-archive-${d.id}`}
                        onClick={() =>
                          setArchiveDialog({
                            kind: 'discount',
                            id: d.id,
                            label: discountDisplay(d),
                            submitting: false,
                            errorMessage: null,
                          })
                        }
                        className="rounded border border-ironwake/40 px-2 py-1 text-xs font-body text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : state.overrides.length === 0 ? (
        <div
          data-testid="exceptions-overrides-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          No pricing overrides on this product. Click{' '}
          <strong>New override</strong> to add one.
        </div>
      ) : (
        <ul data-testid="exceptions-overrides-list" className="flex flex-col gap-2">
          {state.overrides.map((o) => (
            <li
              key={o.id}
              data-testid={`exceptions-override-row-${o.id}`}
              className={
                o.active
                  ? 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-sailcloth p-3'
                  : 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-deep-charcoal/5 p-3'
              }
            >
              <div>
                <p className="font-heading text-base text-primary-navy">
                  {o.metric_name}
                </p>
                <p className="text-xs font-body text-deep-charcoal/70">
                  {formatCurrency(o.unit_price_cents)} per unit
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={o.active ? 'active' : 'archived'} />
                {o.active && (
                  <button
                    type="button"
                    data-testid={`exceptions-override-archive-${o.id}`}
                    onClick={() =>
                      setArchiveDialog({
                        kind: 'override',
                        id: o.id,
                        label: o.metric_name,
                        submitting: false,
                        errorMessage: null,
                      })
                    }
                    className="rounded border border-ironwake/40 px-2 py-1 text-xs font-body text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                  >
                    Archive
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {showNew && activeTab === 'discounts' && (
        <NewDiscountModal
          tenantId={state.product.tenantId}
          productId={productId}
          onCancel={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void load();
          }}
        />
      )}
      {showNew && activeTab === 'overrides' && (
        <NewOverrideModal
          tenantId={state.product.tenantId}
          productId={productId}
          onCancel={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void load();
          }}
        />
      )}
      {archiveDialog && (
        <ArchiveDialog
          state={archiveDialog}
          onCancel={() => setArchiveDialog(null)}
          onConfirm={() => void handleArchiveConfirm()}
        />
      )}
    </div>
  );
}
