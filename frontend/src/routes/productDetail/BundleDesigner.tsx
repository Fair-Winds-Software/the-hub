// Authorized by HUB-1723 (E-V2-PP-1 S10, HUB-1713, HUB-1701) —
// Bundle Designer route: list active + archived bundles for a product, create new
// bundles with member-plan multi-select + discount_type/value fields, archive with
// two-step confirm. Sits at /console/products/:productId/pricing/bundles.
//
// Backend endpoints assumed (out of this story's scope — pricing route hasn't been
// extended yet for bundles; this component uses admin/plan_bundles path):
//   GET  /api/v1/admin/plan_bundles?productId=<uuid>&includeArchived=false
//   POST /api/v1/admin/plan_bundles
//   PUT  /api/v1/admin/plan_bundles/:bundleId   (archive)
// If the endpoints don't exist yet, the UI degrades gracefully to an error state.

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';
import { AccessDeniedPage } from '../../components/AccessDeniedPage';

type DiscountType = 'flat_amount_cents' | 'percent_bps';

interface BundleRow {
  id: string;
  product_id: string;
  bundle_name: string;
  member_plan_ids: string[];
  discount_type: DiscountType;
  discount_value: number;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

interface PlanOption {
  id: string;
  key: string;
  name: string;
}

interface BundleListResponse {
  data: BundleRow[];
  total: number;
}

interface PlansListResponse {
  data: PlanOption[];
  total: number;
}

const BUNDLES_PATH = '/api/v1/admin/plan_bundles';
const PLANS_PATH = '/api/v1/admin/plans';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; bundles: BundleRow[]; plans: PlanOption[] };

// ─── Component ────────────────────────────────────────────────────────────

export function BundleDesigner(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [showArchived, setShowArchived] = useState(false);
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<BundleRow | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const [bundlesRes, plansRes] = await Promise.all([
        apiClient.get<BundleListResponse>(
          `${BUNDLES_PATH}?productId=${productId}&includeArchived=${showArchived ? 'true' : 'false'}`,
        ),
        apiClient.get<PlansListResponse>(`${PLANS_PATH}?productId=${productId}`),
      ]);
      setState({ kind: 'ready', bundles: bundlesRes.data, plans: plansRes.data });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to load bundles.';
      setState({ kind: 'error', message });
    }
  }, [productId, showArchived]);

  useEffect(() => { void load(); }, [load]);

  const handleCreated = (): void => {
    setNewModalOpen(false);
    void load();
  };

  const handleArchive = async (): Promise<void> => {
    if (archiveTarget === null) return;
    try {
      await apiClient.put(`${BUNDLES_PATH}/${archiveTarget.id}`, { status: 'archived' });
      setArchiveTarget(null);
      void load();
    } catch (err) {
      // Surface the error in the same modal; user re-tries.
      const message = err instanceof Error ? err.message : 'Archive failed.';
      alert(message); // eslint-disable-line no-alert
    }
  };

  if (state.kind === 'denied') {
    return (
      <AccessDeniedPage
        resourceLabel="this product's bundles"
        backTo={`/console/products/${productId}/pricing/plans`}
      />
    );
  }

  return (
    <section className="mx-auto max-w-6xl p-4" data-testid="bundle-designer-page">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl text-primary-navy">Bundle designer</h1>
          <p className="text-sm font-body text-deep-charcoal/70">
            Plan-bundle discounts for this product. LaunchKit Full-Stack = Mobile + Desktop − $500,
            declared here. Bundles do not stack — largest matching discount wins per E-V2-PP-1 S7.
          </p>
          <Link
            to={`/console/products/${productId}/pricing/plans`}
            className="mt-1 inline-block text-xs font-body text-primary-navy underline"
          >
            ← Back to plans
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            <input
              type="checkbox"
              data-testid="bundle-show-archived"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <button
            type="button"
            data-testid="new-bundle-button"
            onClick={() => setNewModalOpen(true)}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            + New bundle
          </button>
        </div>
      </header>

      {state.kind === 'loading' && (
        <p data-testid="bundle-loading" className="text-sm text-deep-charcoal/70">
          Loading…
        </p>
      )}
      {state.kind === 'error' && (
        <p role="alert" data-testid="bundle-error" className="text-sm text-error-crimson">
          {state.message}
        </p>
      )}

      {state.kind === 'ready' && state.bundles.length === 0 && (
        <div className="rounded border border-dashed border-deep-charcoal/30 p-6 text-center">
          <p data-testid="bundle-empty" className="text-sm font-body text-deep-charcoal/70">
            No bundles yet — create your first.
          </p>
        </div>
      )}

      {state.kind === 'ready' && state.bundles.length > 0 && (
        <table className="w-full border-collapse text-sm font-body">
          <thead>
            <tr className="border-b border-deep-charcoal/20 text-left text-deep-charcoal/70">
              <th scope="col" className="py-2 pr-2">Name</th>
              <th scope="col" className="py-2 pr-2">Members</th>
              <th scope="col" className="py-2 pr-2">Discount</th>
              <th scope="col" className="py-2 pr-2">Status</th>
              <th scope="col" className="py-2 pr-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.bundles.map((b) => (
              <BundleRowView
                key={b.id}
                bundle={b}
                plans={state.plans}
                onArchive={() => setArchiveTarget(b)}
              />
            ))}
          </tbody>
        </table>
      )}

      {newModalOpen && state.kind === 'ready' && (
        <NewBundleModal
          productId={productId}
          plans={state.plans}
          onCancel={() => setNewModalOpen(false)}
          onCreated={handleCreated}
        />
      )}

      {archiveTarget !== null && (
        <div
          role="alertdialog"
          aria-modal="true"
          data-testid="archive-bundle-dialog"
          className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
        >
          <div className="w-full max-w-sm rounded-md bg-sailcloth p-4 shadow-lg">
            <h2 className="mb-2 font-heading text-lg text-primary-navy">
              Archive bundle &lsquo;{archiveTarget.bundle_name}&rsquo;?
            </h2>
            <p className="mb-4 text-sm font-body text-deep-charcoal/80">
              This stops the discount applying to future invoices. Existing invoiced discounts are
              preserved.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="archive-bundle-cancel"
                onClick={() => setArchiveTarget(null)}
                className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="archive-bundle-confirm"
                onClick={() => void handleArchive()}
                className="rounded bg-error-crimson px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-error-crimson/90"
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── BundleRowView ────────────────────────────────────────────────────────

function BundleRowView({
  bundle,
  plans,
  onArchive,
}: {
  bundle: BundleRow;
  plans: PlanOption[];
  onArchive: () => void;
}): React.ReactElement {
  const memberNames = bundle.member_plan_ids
    .map((id) => plans.find((p) => p.id === id)?.name ?? `<${id.slice(0, 8)}>`)
    .join(', ');
  const discountText = bundle.discount_type === 'flat_amount_cents'
    ? `$${(bundle.discount_value / 100).toFixed(2)} flat`
    : `${(bundle.discount_value / 100).toFixed(2)}% (${bundle.discount_value} bps)`;
  return (
    <tr data-testid={`bundle-row-${bundle.id}`} className="border-b border-deep-charcoal/10">
      <td className="py-2 pr-2 font-body text-primary-navy">{bundle.bundle_name}</td>
      <td className="py-2 pr-2 font-body text-deep-charcoal">{memberNames}</td>
      <td className="py-2 pr-2 font-body text-deep-charcoal">{discountText}</td>
      <td className="py-2 pr-2 font-body text-deep-charcoal">{bundle.status}</td>
      <td className="py-2 pr-2 text-right">
        {bundle.status === 'active' && (
          <button
            type="button"
            data-testid={`bundle-archive-${bundle.id}`}
            onClick={onArchive}
            className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5"
          >
            Archive
          </button>
        )}
      </td>
    </tr>
  );
}

// ─── NewBundleModal ───────────────────────────────────────────────────────

interface NewBundleModalProps {
  productId: string;
  plans: PlanOption[];
  onCancel: () => void;
  onCreated: () => void;
}

interface NewBundleDraft {
  bundle_name: string;
  member_plan_ids: string[];
  discount_type: DiscountType;
  discount_value: string;
}

const INITIAL_DRAFT: NewBundleDraft = {
  bundle_name: '',
  member_plan_ids: [],
  discount_type: 'flat_amount_cents',
  discount_value: '',
};

export function validateNewBundle(draft: NewBundleDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.bundle_name.trim().length < 3) {
    errors['bundle_name'] = 'Bundle name must be ≥ 3 characters.';
  }
  if (draft.member_plan_ids.length < 2) {
    errors['member_plan_ids'] = 'Select at least 2 member plans.';
  }
  const val = parseInt(draft.discount_value, 10);
  if (Number.isNaN(val) || val < 0) {
    errors['discount_value'] = 'Discount value must be a non-negative integer.';
  } else if (draft.discount_type === 'percent_bps' && val > 10000) {
    errors['discount_value'] = 'Percent basis points cannot exceed 10000.';
  }
  return errors;
}

function NewBundleModal({
  productId,
  plans,
  onCancel,
  onCreated,
}: NewBundleModalProps): React.ReactElement {
  const [draft, setDraft] = useState<NewBundleDraft>(INITIAL_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const errors = validateNewBundle(draft);

  const toggleMember = (planId: string): void => {
    setDraft({
      ...draft,
      member_plan_ids: draft.member_plan_ids.includes(planId)
        ? draft.member_plan_ids.filter((p) => p !== planId)
        : [...draft.member_plan_ids, planId],
    });
  };

  const handleSubmit = async (): Promise<void> => {
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await apiClient.post(BUNDLES_PATH, {
        product_id: productId,
        bundle_name: draft.bundle_name,
        member_plan_ids: draft.member_plan_ids,
        discount_type: draft.discount_type,
        discount_value: parseInt(draft.discount_value, 10),
      });
      onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed.';
      setServerError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = Object.keys(errors).length === 0 && !submitting;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-bundle-heading"
      data-testid="new-bundle-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2 id="new-bundle-heading" className="mb-3 font-heading text-lg text-primary-navy">
          New bundle
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Bundle name
            <input
              type="text"
              data-testid="new-bundle-name"
              value={draft.bundle_name}
              onChange={(e) => setDraft({ ...draft, bundle_name: e.target.value })}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors['bundle_name'] && (
              <span role="alert" className="text-xs text-error-crimson">
                {errors['bundle_name']}
              </span>
            )}
          </label>
          <div className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            <span>Member plans (select ≥ 2)</span>
            <div
              data-testid="new-bundle-members"
              className="max-h-40 overflow-y-auto rounded border border-deep-charcoal/20 p-2"
            >
              {plans.length === 0 && (
                <span className="text-xs text-deep-charcoal/60">
                  No plans available. Add plans first.
                </span>
              )}
              {plans.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 py-1 text-xs font-body text-deep-charcoal"
                >
                  <input
                    type="checkbox"
                    data-testid={`new-bundle-member-${p.id}`}
                    checked={draft.member_plan_ids.includes(p.id)}
                    onChange={() => toggleMember(p.id)}
                  />
                  {p.name} <code className="text-deep-charcoal/50">({p.key})</code>
                </label>
              ))}
            </div>
            {errors['member_plan_ids'] && (
              <span role="alert" className="text-xs text-error-crimson">
                {errors['member_plan_ids']}
              </span>
            )}
          </div>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Discount type
            <select
              data-testid="new-bundle-discount-type"
              value={draft.discount_type}
              onChange={(e) =>
                setDraft({ ...draft, discount_type: e.target.value as DiscountType })
              }
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="flat_amount_cents">Flat amount (cents)</option>
              <option value="percent_bps">Percent (basis points, 0–10000)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Discount value
            <input
              type="number"
              data-testid="new-bundle-discount-value"
              min={0}
              value={draft.discount_value}
              onChange={(e) => setDraft({ ...draft, discount_value: e.target.value })}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors['discount_value'] && (
              <span role="alert" data-testid="new-bundle-discount-value-error" className="text-xs text-error-crimson">
                {errors['discount_value']}
              </span>
            )}
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="new-bundle-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="new-bundle-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="new-bundle-submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create bundle'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BundleDesigner;
