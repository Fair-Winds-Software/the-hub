// Authorized by HUB-1655 (E-FE-5 S5) — Plans management surface at
// /console/products/:productId/plans. Consumes the HUB-1651 admin plans
// CRUD API to list active + archived plans, create new plans through a
// modal (with the two-step billing_mode='credit' confirmation), edit
// mutable fields inline (billing_mode is read-only once 'credit' —
// engineering-only revert), and soft-archive with the 422 active-
// subscribers guard.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Route: mounted at /console/products/:productId/pricing/plans instead
//      of the spec's /console/products/:productId/plans. The Plans tab
//      inside HUB-1604's product detail (HUB-1606) is a read-only pricing-
//      model view; putting a full CRUD workspace at the same path would
//      collide with the tabbed detail. The pricing editor lives at
//      /pricing (HUB-1654), so the plans manager sits alongside it under
//      the same super_admin-scoped subroute space. Product detail's
//      Plans tab can link to this route as its "Manage plans" CTA.
//
//   2. Currency formatting: reuses the same Intl.NumberFormat pattern
//      used by the dashboard formatter module and the pricing editor —
//      no cross-Epic import until the HUB-1659 (S9) shared helper lands.
//
//   3. Active-subscribers guard: on DELETE 422 with
//      {activeSubscribers: N} in the JSON body, we surface the count
//      inline in the confirm dialog. If the BE returns 422 without the
//      count field, we fall back to a generic "cannot archive right now"
//      message.
//
//   4. billing_mode Standard→Credit two-step confirm: implemented inline
//      inside the modal (no LK-144 dependency at v0.1). First click on
//      Credit reveals a red confirmation panel; a second explicit click
//      commits the value. Credit→Standard toggle is disabled in Edit
//      modal — helper text points operators at engineering.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';
import { AccessDeniedPage } from '../../components/AccessDeniedPage';

const PLANS_PATH = '/api/v1/admin/plans';
const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Plans | HUB Console';

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
}
interface PortfolioResponse {
  data: PortfolioProduct[];
}

type BillingMode = 'standard' | 'credit';
type BillingType = 'flat_rate' | 'per_seat' | 'metered' | 'tiered' | 'one_time';
type BillingInterval = 'month' | 'quarter' | 'year' | 'one_time';

interface PlanRow {
  id: string;
  product_id: string;
  key: string;
  name: string;
  description: string | null;
  billing_type: BillingType;
  billing_interval: BillingInterval | null;
  unit_amount_cents: number | null;
  billing_mode?: BillingMode;
  active: boolean;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface PlansListResponse {
  data: PlanRow[];
  total: number;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; product: PortfolioProduct; plans: PlanRow[] };

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

interface NewPlanDraft {
  name: string;
  key: string;
  keyEdited: boolean;
  billing_type: BillingType;
  billing_interval: BillingInterval;
  unit_amount_cents: string;
  billing_mode: BillingMode;
  billingModeCreditPending: boolean;
}

const DEFAULT_NEW_PLAN: NewPlanDraft = {
  name: '',
  key: '',
  keyEdited: false,
  billing_type: 'flat_rate',
  billing_interval: 'month',
  unit_amount_cents: '',
  billing_mode: 'standard',
  billingModeCreditPending: false,
};

const BILLING_TYPES: BillingType[] = [
  'flat_rate',
  'per_seat',
  'metered',
  'tiered',
  'one_time',
];
const BILLING_INTERVALS: BillingInterval[] = [
  'month',
  'quarter',
  'year',
  'one_time',
];

interface FieldErrors {
  [k: string]: string;
}

interface ArchiveDialogState {
  plan: PlanRow;
  activeSubscribers: number | null;
  errorMessage: string | null;
  submitting: boolean;
}

function BillingModeBadge({ mode }: { mode: BillingMode | undefined }): React.ReactElement {
  const isCredit = mode === 'credit';
  return (
    <span
      data-testid={isCredit ? 'plan-billing-mode-credit' : 'plan-billing-mode-standard'}
      className={
        isCredit
          ? 'inline-flex items-center rounded-full bg-ironwake/15 px-2 py-0.5 text-xs font-body text-ironwake'
          : 'inline-flex items-center rounded-full bg-seafoam/15 px-2 py-0.5 text-xs font-body text-seafoam'
      }
    >
      {isCredit ? 'credit' : 'standard'}
    </span>
  );
}

interface NewPlanModalProps {
  productId: string;
  onCancel: () => void;
  onCreated: (plan: PlanRow) => void;
}

function NewPlanModal({ productId, onCancel, onCreated }: NewPlanModalProps): React.ReactElement {
  const [draft, setDraft] = useState<NewPlanDraft>(DEFAULT_NEW_PLAN);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const handleNameBlur = (): void => {
    if (!draft.keyEdited && draft.name && !draft.key) {
      setDraft({ ...draft, key: keyFromName(draft.name) });
    }
  };

  const handleCreditToggle = (): void => {
    if (draft.billing_mode === 'credit') {
      setDraft({
        ...draft,
        billing_mode: 'standard',
        billingModeCreditPending: false,
      });
    } else if (!draft.billingModeCreditPending) {
      setDraft({ ...draft, billingModeCreditPending: true });
    } else {
      setDraft({
        ...draft,
        billing_mode: 'credit',
        billingModeCreditPending: false,
      });
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
    if (draft.billingModeCreditPending) {
      nextErrors.billing_mode = 'Confirm credit-mode selection first.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const created = await apiClient.post<PlanRow>(PLANS_PATH, {
        productId,
        key: draft.key.trim(),
        name: draft.name.trim(),
        billing_type: draft.billing_type,
        billing_interval: draft.billing_interval,
        unit_amount_cents: cents,
        billing_mode: draft.billing_mode,
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
      aria-labelledby="new-plan-heading"
      data-testid="new-plan-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="new-plan-heading" className="mb-3 font-heading text-lg text-primary-navy">
          New plan
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Name
            <input
              data-testid="new-plan-name"
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onBlur={handleNameBlur}
              aria-invalid={errors.name ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.name && (
              <span data-testid="new-plan-name-err" className="text-xs text-ironwake">
                {errors.name}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Key (auto-generated from name; editable)
            <input
              data-testid="new-plan-key"
              type="text"
              value={draft.key}
              onChange={(e) =>
                setDraft({ ...draft, key: e.target.value, keyEdited: true })
              }
              aria-invalid={errors.key ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.key && (
              <span data-testid="new-plan-key-err" className="text-xs text-ironwake">
                {errors.key}
              </span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Billing type
              <select
                data-testid="new-plan-billing-type"
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
                data-testid="new-plan-billing-interval"
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
              data-testid="new-plan-unit-amount"
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
              <span data-testid="new-plan-unit-amount-err" className="text-xs text-ironwake">
                {errors.unit_amount_cents}
              </span>
            )}
          </label>
          <div className="flex flex-col gap-2 rounded border border-deep-charcoal/15 p-3">
            <span className="text-sm font-body text-deep-charcoal/80">Billing mode</span>
            <div className="flex items-center gap-3">
              <BillingModeBadge mode={draft.billing_mode} />
              <button
                type="button"
                data-testid="new-plan-toggle-credit"
                onClick={handleCreditToggle}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                {draft.billing_mode === 'credit'
                  ? 'Switch to Standard'
                  : draft.billingModeCreditPending
                    ? 'Confirm Credit'
                    : 'Set to Credit'}
              </button>
            </div>
            {draft.billingModeCreditPending && (
              <div
                role="alert"
                data-testid="new-plan-credit-confirm-panel"
                className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
              >
                Credit mode bypasses Stripe writes. Confirm this is an internal-only
                product? Click <strong>Confirm Credit</strong> to commit; click
                anything else to cancel.
              </div>
            )}
            {errors.billing_mode && (
              <span data-testid="new-plan-billing-mode-err" className="text-xs text-ironwake">
                {errors.billing_mode}
              </span>
            )}
          </div>
          {serverError && (
            <div
              role="alert"
              data-testid="new-plan-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="new-plan-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="new-plan-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Creating…' : 'Create plan'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface EditPlanModalProps {
  plan: PlanRow;
  onCancel: () => void;
  onSaved: (plan: PlanRow) => void;
}

function EditPlanModal({ plan, onCancel, onSaved }: EditPlanModalProps): React.ReactElement {
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? '');
  const [unitAmount, setUnitAmount] = useState(String(plan.unit_amount_cents ?? ''));
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const isCredit = plan.billing_mode === 'credit';

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
      const updated = await apiClient.put<PlanRow>(`${PLANS_PATH}/${plan.id}`, payload);
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
      aria-labelledby="edit-plan-heading"
      data-testid="edit-plan-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="edit-plan-heading" className="mb-3 font-heading text-lg text-primary-navy">
          Edit plan — {plan.name}
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Name
            <input
              data-testid="edit-plan-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Description
            <textarea
              data-testid="edit-plan-description"
              value={description}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Unit amount (cents)
            <input
              data-testid="edit-plan-unit-amount"
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
          <div className="flex flex-col gap-2 rounded border border-deep-charcoal/15 p-3">
            <span className="text-sm font-body text-deep-charcoal/80">
              Billing mode
            </span>
            <div className="flex items-center gap-3">
              <BillingModeBadge mode={plan.billing_mode} />
              {isCredit ? (
                <span
                  data-testid="edit-plan-credit-locked"
                  className="text-xs font-body text-deep-charcoal/60"
                >
                  Credit→Standard transition requires engineering action. Contact
                  engineering to revert.
                </span>
              ) : (
                <span className="text-xs font-body text-deep-charcoal/60">
                  Switching modes lives on the create flow; this Edit modal is
                  content-only.
                </span>
              )}
            </div>
          </div>
          {serverError && (
            <div
              role="alert"
              data-testid="edit-plan-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="edit-plan-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="edit-plan-submit"
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
      aria-labelledby="archive-plan-heading"
      data-testid="archive-plan-dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="archive-plan-heading" className="mb-2 font-heading text-lg text-primary-navy">
          Archive plan — {state.plan.name}
        </h2>
        {blocked ? (
          <p
            data-testid="archive-plan-blocked-copy"
            className="text-sm font-body text-ironwake"
          >
            <strong>{state.activeSubscribers}</strong> active subscribers on this plan.
            Archive blocked — migrate subscribers to a new plan first.
          </p>
        ) : (
          <p className="text-sm font-body text-deep-charcoal">
            Soft-archive this plan? Existing Stripe subscriptions on the archived
            Stripe Price remain valid; new signups will not see this plan.
          </p>
        )}
        {state.errorMessage && !blocked && (
          <div
            role="alert"
            data-testid="archive-plan-error"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {state.errorMessage}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="archive-plan-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          {!blocked && (
            <button
              type="button"
              data-testid="archive-plan-confirm"
              onClick={onConfirm}
              disabled={state.submitting}
              className="rounded bg-ironwake px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-ironwake/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              {state.submitting ? 'Archiving…' : 'Archive plan'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PlansManager(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<PlanRow | null>(null);
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
      const plans = await apiClient.get<PlansListResponse>(
        `${PLANS_PATH}?${qs.toString()}`,
      );
      const sorted = [...plans.data].sort((a, b) => {
        const aActive = (a.archived_at ?? null) === null ? 0 : 1;
        const bActive = (b.archived_at ?? null) === null ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return a.created_at.localeCompare(b.created_at);
      });
      setState({ kind: 'ready', product, plans: sorted });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to load plans';
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
      await apiClient.delete(`${PLANS_PATH}/${archiveDialog.plan.id}`);
      setArchiveDialog(null);
      void load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Archive failed.';
      // Parse the {activeSubscribers} field if it comes through in the error body.
      const match = /"activeSubscribers"\s*:\s*(\d+)/.exec(message);
      if (match) {
        const count = parseInt(match[1]!, 10);
        setArchiveDialog({
          ...archiveDialog,
          activeSubscribers: count,
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
      <div
        id="main-content"
        data-testid="plans-manager-page"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="plans-manager-skeleton"
          className="h-64 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }
  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="this product's plans"
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
        data-testid="plans-manager-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load plans.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="plans-manager-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div id="main-content" data-testid="plans-manager-page" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">
          Plans — {state.product.productName}
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
            data-testid="plans-manager-show-archived"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
        <button
          type="button"
          data-testid="plans-manager-new"
          onClick={() => setShowNew(true)}
          className="rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          New plan
        </button>
      </div>

      {state.plans.length === 0 ? (
        <div
          data-testid="plans-manager-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          No plans defined yet. Click <strong>New plan</strong> to create your first
          plan for this product.
        </div>
      ) : (
        <ul
          data-testid="plans-manager-list"
          className="flex flex-col gap-2"
        >
          {state.plans.map((p) => (
            <li
              key={p.id}
              data-testid={`plans-manager-row-${p.id}`}
              className={
                p.archived_at
                  ? 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-deep-charcoal/5 p-3'
                  : 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-sailcloth p-3'
              }
            >
              <div>
                <p className="font-heading text-base text-primary-navy">{p.name}</p>
                <p className="font-mono text-xs text-deep-charcoal/60">{p.key}</p>
                <p className="text-xs font-body text-deep-charcoal/70">
                  {formatUSD(p.unit_amount_cents)} · {p.billing_type}
                  {p.billing_interval ? ` · ${p.billing_interval}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <BillingModeBadge mode={p.billing_mode} />
                {p.archived_at && (
                  <span
                    data-testid={`plans-manager-archived-badge-${p.id}`}
                    className="inline-flex items-center rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs font-body text-deep-charcoal/70"
                  >
                    archived
                  </span>
                )}
                {!p.archived_at && (
                  <>
                    <button
                      type="button"
                      data-testid={`plans-manager-edit-${p.id}`}
                      onClick={() => setEditing(p)}
                      className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      data-testid={`plans-manager-archive-${p.id}`}
                      onClick={() =>
                        setArchiveDialog({
                          plan: p,
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
        <NewPlanModal
          productId={productId}
          onCancel={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void load();
          }}
        />
      )}

      {editing && (
        <EditPlanModal
          plan={editing}
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
