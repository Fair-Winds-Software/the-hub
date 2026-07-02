// Authorized by HUB-1656 (E-FE-5 S6) — Add-on management surface at
// /console/products/:productId/pricing/addons. Thin mirror of HUB-1655's
// PlansManager pattern (list + New modal + Edit modal + Archive dialog +
// Show archived toggle). No billing_mode toggle — add-ons don't have one.
//
// Consumes the HUB-1652 admin add-ons CRUD API. Currency formatting uses
// the same Intl.NumberFormat pattern; the shared helper lands in HUB-1659
// (S9). Two-step archive confirm is inline (no LK-144 dependency at v0.1).
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Route path: /pricing/addons instead of /addons — same rationale as
//      HUB-1655 (avoid colliding with the existing product-detail tabs).
//
//   2. Restore action: the HUB-1652 PUT endpoint does not currently
//      accept archived_at as a field on the patch (updateAddOn's
//      whitelist is name / description / unit_amount_cents). Restore is
//      documented as HUB-1545 tech debt; the FE UI shows archived rows
//      when the toggle is on but no restore CTA at v0.1. When BE adds
//      an unarchive path, wire it in one branch.
//
//   3. Active-references guard: DELETE 422 with {activeSubscribers: N}
//      renders the count inline in the confirm dialog (same shape as
//      HUB-1655's plans archive dialog).
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';
import { AccessDeniedPage } from '../../components/AccessDeniedPage';

const ADDONS_PATH = '/api/v1/admin/addons';
const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Add-ons | HUB Console';

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
}
interface PortfolioResponse {
  data: PortfolioProduct[];
}

type BillingType = 'recurring' | 'one_time';
type BillingInterval = 'month' | 'quarter' | 'year' | 'one_time';

interface AddOnRow {
  id: string;
  product_id: string;
  key: string;
  name: string;
  description: string | null;
  billing_type: BillingType;
  billing_interval: BillingInterval | null;
  unit_amount_cents: number;
  active: boolean;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface AddOnListResponse {
  data: AddOnRow[];
  total: number;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; product: PortfolioProduct; addons: AddOnRow[] };

const BILLING_TYPES: BillingType[] = ['recurring', 'one_time'];
const BILLING_INTERVALS: BillingInterval[] = [
  'month',
  'quarter',
  'year',
  'one_time',
];

function formatUSD(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface FieldErrors {
  [k: string]: string;
}

interface NewAddOnDraft {
  name: string;
  key: string;
  keyEdited: boolean;
  billing_type: BillingType;
  billing_interval: BillingInterval;
  unit_amount_cents: string;
  description: string;
}

const DEFAULT_NEW: NewAddOnDraft = {
  name: '',
  key: '',
  keyEdited: false,
  billing_type: 'recurring',
  billing_interval: 'month',
  unit_amount_cents: '',
  description: '',
};

interface NewAddOnModalProps {
  productId: string;
  onCancel: () => void;
  onCreated: (addon: AddOnRow) => void;
}

function NewAddOnModal({ productId, onCancel, onCreated }: NewAddOnModalProps): React.ReactElement {
  const [draft, setDraft] = useState<NewAddOnDraft>(DEFAULT_NEW);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const handleNameBlur = (): void => {
    if (!draft.keyEdited && draft.name && !draft.key) {
      setDraft({ ...draft, key: keyFromName(draft.name) });
    }
  };

  const handleSubmit = async (): Promise<void> => {
    const nextErrors: FieldErrors = {};
    if (!draft.name.trim()) nextErrors.name = 'Name is required.';
    if (!draft.key.trim()) nextErrors.key = 'Key is required.';
    const cents = parseInt(draft.unit_amount_cents, 10);
    if (isNaN(cents) || cents < 0) {
      nextErrors.unit_amount_cents = 'Unit amount must be a non-negative integer (cents).';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const created = await apiClient.post<AddOnRow>(ADDONS_PATH, {
        productId,
        key: draft.key.trim(),
        name: draft.name.trim(),
        billing_type: draft.billing_type,
        billing_interval: draft.billing_interval,
        unit_amount_cents: cents,
        description: draft.description.length > 0 ? draft.description : undefined,
      });
      onCreated(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed.';
      setServerError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-addon-heading"
      data-testid="new-addon-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="new-addon-heading" className="mb-3 font-heading text-lg text-primary-navy">
          New add-on
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Name
            <input
              data-testid="new-addon-name"
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onBlur={handleNameBlur}
              aria-invalid={errors.name ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.name && (
              <span data-testid="new-addon-name-err" className="text-xs text-ironwake">
                {errors.name}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Key (auto-generated; editable)
            <input
              data-testid="new-addon-key"
              type="text"
              value={draft.key}
              onChange={(e) =>
                setDraft({ ...draft, key: e.target.value, keyEdited: true })
              }
              aria-invalid={errors.key ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.key && (
              <span data-testid="new-addon-key-err" className="text-xs text-ironwake">
                {errors.key}
              </span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Billing type
              <select
                data-testid="new-addon-billing-type"
                value={draft.billing_type}
                onChange={(e) =>
                  setDraft({ ...draft, billing_type: e.target.value as BillingType })
                }
                className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                {BILLING_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Billing interval
              <select
                data-testid="new-addon-billing-interval"
                value={draft.billing_interval}
                onChange={(e) =>
                  setDraft({ ...draft, billing_interval: e.target.value as BillingInterval })
                }
                className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                {BILLING_INTERVALS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Unit amount (cents)
            <input
              data-testid="new-addon-unit-amount"
              type="text"
              inputMode="numeric"
              value={draft.unit_amount_cents}
              onChange={(e) =>
                setDraft({ ...draft, unit_amount_cents: e.target.value })
              }
              aria-invalid={errors.unit_amount_cents ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {draft.unit_amount_cents && (
              <span className="text-xs text-deep-charcoal/60">
                = {formatUSD(parseInt(draft.unit_amount_cents, 10) || 0)}
              </span>
            )}
            {errors.unit_amount_cents && (
              <span data-testid="new-addon-unit-amount-err" className="text-xs text-ironwake">
                {errors.unit_amount_cents}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Description (optional)
            <textarea
              data-testid="new-addon-description"
              value={draft.description}
              rows={2}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="new-addon-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="new-addon-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="new-addon-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Creating…' : 'Create add-on'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface EditAddOnModalProps {
  addon: AddOnRow;
  onCancel: () => void;
  onSaved: (addon: AddOnRow) => void;
}

function EditAddOnModal({ addon, onCancel, onSaved }: EditAddOnModalProps): React.ReactElement {
  const [name, setName] = useState(addon.name);
  const [description, setDescription] = useState(addon.description ?? '');
  const [unitAmount, setUnitAmount] = useState(String(addon.unit_amount_cents));
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const handleSave = async (): Promise<void> => {
    setSubmitting(true);
    setServerError(null);
    try {
      const payload: Record<string, unknown> = {
        name,
        description: description.length > 0 ? description : null,
      };
      if (unitAmount.trim().length > 0) {
        payload.unit_amount_cents = parseInt(unitAmount, 10);
      }
      const updated = await apiClient.put<AddOnRow>(
        `${ADDONS_PATH}/${addon.id}`,
        payload,
      );
      onSaved(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed.';
      setServerError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-addon-heading"
      data-testid="edit-addon-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="edit-addon-heading" className="mb-3 font-heading text-lg text-primary-navy">
          Edit add-on — {addon.name}
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Name
            <input
              data-testid="edit-addon-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Description
            <textarea
              data-testid="edit-addon-description"
              value={description}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Unit amount (cents)
            <input
              data-testid="edit-addon-unit-amount"
              type="text"
              inputMode="numeric"
              value={unitAmount}
              onChange={(e) => setUnitAmount(e.target.value)}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {unitAmount && (
              <span className="text-xs text-deep-charcoal/60">
                = {formatUSD(parseInt(unitAmount, 10) || 0)}
              </span>
            )}
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="edit-addon-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="edit-addon-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="edit-addon-submit"
            onClick={() => void handleSave()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ArchiveDialogState {
  addon: AddOnRow;
  activeSubscribers: number | null;
  errorMessage: string | null;
  submitting: boolean;
}

interface ArchiveDialogProps {
  state: ArchiveDialogState;
  onCancel: () => void;
  onConfirm: () => void;
}

function ArchiveDialog({ state, onCancel, onConfirm }: ArchiveDialogProps): React.ReactElement {
  const blocked = state.activeSubscribers !== null && state.activeSubscribers > 0;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="archive-addon-heading"
      data-testid="archive-addon-dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="archive-addon-heading" className="mb-2 font-heading text-lg text-primary-navy">
          Archive add-on — {state.addon.name}
        </h2>
        {blocked ? (
          <p
            data-testid="archive-addon-blocked-copy"
            className="text-sm font-body text-ironwake"
          >
            <strong>{state.activeSubscribers}</strong> active subscribers on this add-on.
            Archive blocked — deactivate subscribers first.
          </p>
        ) : (
          <p className="text-sm font-body text-deep-charcoal">
            Archive this add-on? It will be hidden from the active list but
            preserved for billing history.
          </p>
        )}
        {state.errorMessage && !blocked && (
          <div
            role="alert"
            data-testid="archive-addon-error"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {state.errorMessage}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="archive-addon-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          {!blocked && (
            <button
              type="button"
              data-testid="archive-addon-confirm"
              onClick={onConfirm}
              disabled={state.submitting}
              className="rounded bg-ironwake px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-ironwake/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              {state.submitting ? 'Archiving…' : 'Archive add-on'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AddOnsManager(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<AddOnRow | null>(null);
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
      const qs = new URLSearchParams({
        productId,
        includeArchived: includeArchived ? 'true' : 'false',
      });
      const addons = await apiClient.get<AddOnListResponse>(
        `${ADDONS_PATH}?${qs.toString()}`,
      );
      const sorted = [...addons.data].sort((a, b) => {
        const aArchived = (a.archived_at ?? null) === null ? 0 : 1;
        const bArchived = (b.archived_at ?? null) === null ? 0 : 1;
        if (aArchived !== bArchived) return aArchived - bArchived;
        return a.created_at.localeCompare(b.created_at);
      });
      setState({ kind: 'ready', product, addons: sorted });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to load add-ons';
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
      await apiClient.delete(`${ADDONS_PATH}/${archiveDialog.addon.id}`);
      setArchiveDialog(null);
      void load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Archive failed.';
      const match = /"activeSubscribers"\s*:\s*(\d+)/.exec(message);
      if (match) {
        setArchiveDialog({
          ...archiveDialog,
          activeSubscribers: parseInt(match[1]!, 10),
          errorMessage: null,
          submitting: false,
        });
      } else {
        setArchiveDialog({
          ...archiveDialog,
          errorMessage: message,
          submitting: false,
        });
      }
    }
  }, [archiveDialog, load]);

  if (state.kind === 'loading') {
    return (
      <div id="main-content" data-testid="addons-manager-page" className="flex flex-col gap-4">
        <div data-testid="addons-manager-skeleton" className="h-64 animate-pulse rounded-md bg-deep-charcoal/5" />
      </div>
    );
  }
  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="this product's add-ons"
          backTo="/console/products"
          backLabel="Back to products"
        />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div id="main-content" role="alert" data-testid="addons-manager-error" className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake">
        <p className="font-medium">Couldn’t load add-ons.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="addons-manager-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div id="main-content" data-testid="addons-manager-page" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">
          Add-ons — {state.product.productName}
        </h1>
        <Link
          to={`/console/products/${productId}`}
          className="w-fit text-xs font-body text-primary-navy underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          ← Back to product
        </Link>
      </header>

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
          <input
            type="checkbox"
            data-testid="addons-manager-show-archived"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
        <button
          type="button"
          data-testid="addons-manager-new"
          onClick={() => setShowNew(true)}
          className="rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          New add-on
        </button>
      </div>

      {state.addons.length === 0 ? (
        <div
          data-testid="addons-manager-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          No add-ons defined yet. Click <strong>New add-on</strong> to create
          one for this product.
        </div>
      ) : (
        <ul data-testid="addons-manager-list" className="flex flex-col gap-2">
          {state.addons.map((a) => (
            <li
              key={a.id}
              data-testid={`addons-manager-row-${a.id}`}
              className={
                a.archived_at
                  ? 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-deep-charcoal/5 p-3'
                  : 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-sailcloth p-3'
              }
            >
              <div>
                <p className="font-heading text-base text-primary-navy">{a.name}</p>
                <p className="font-mono text-xs text-deep-charcoal/60">{a.key}</p>
                <p className="text-xs font-body text-deep-charcoal/70">
                  {formatUSD(a.unit_amount_cents)} · {a.billing_type}
                  {a.billing_interval ? ` · ${a.billing_interval}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {a.archived_at && (
                  <span
                    data-testid={`addons-manager-archived-badge-${a.id}`}
                    className="inline-flex items-center rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs font-body text-deep-charcoal/70"
                  >
                    archived
                  </span>
                )}
                {!a.archived_at && (
                  <>
                    <button
                      type="button"
                      data-testid={`addons-manager-edit-${a.id}`}
                      onClick={() => setEditing(a)}
                      className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      data-testid={`addons-manager-archive-${a.id}`}
                      onClick={() =>
                        setArchiveDialog({
                          addon: a,
                          activeSubscribers: null,
                          errorMessage: null,
                          submitting: false,
                        })
                      }
                      className="rounded border border-ironwake/40 px-2 py-1 text-xs font-body text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                    >
                      Archive
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {showNew && (
        <NewAddOnModal
          productId={productId}
          onCancel={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void load();
          }}
        />
      )}

      {editing && (
        <EditAddOnModal
          addon={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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
