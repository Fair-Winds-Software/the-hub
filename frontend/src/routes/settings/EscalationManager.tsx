// Authorized by HUB-1666 (E-FE-6 S7) — Escalation rules management sub-route
// at /console/settings/escalation. Fetches the operator's products,
// on selection lists all rules for the tenant+product, groups them by
// alert_type, and lets the operator add / archive rules per alert_type
// within the BE's hard 2-tier cap.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Data model: story spec described { event_type, priority,
//      channel_id, delay_seconds, condition (JSON expression) }. The BE
//      model at notifications.ts:308 is
//      { tier (1|2), alert_type, threshold_minutes, escalation_contacts[] }
//      with a UNIQUE index enforcing at most 2 tiers per (tenant,
//      product, alert_type). Channel references are unsupported at v0.1;
//      contacts are stored as free-form JSON. HUB-1545 tech debt
//      candidate: extend the BE to reference S6 channels + surface a
//      priority field.
//
//   2. Drag-to-reorder: not implementable at v0.1 — the 2-tier cap
//      means the only reorder is 'swap tier 1 and tier 2', which is
//      simpler to expose as an explicit tier picker in the modal.
//      HUB-1545 tech debt candidate: build the drag UX once the model
//      supports N > 2 priorities.
//
//   3. PUT / edit-in-place: no BE PUT for rules. Editing is
//      archive+recreate per the BE contract. The FE surfaces this as
//      Archive → New: no in-line Edit CTA. HUB-1545 tech debt candidate:
//      add a PUT endpoint for name/delay changes without a full recreate.
//
//   4. Soft-archive: HUB-1661 shipped soft-archive on this table;
//      Archive uses the same 2-step confirm pattern as HUB-1665
//      Notifications, and 'Show archived' reveals tombstoned rules.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Escalation | Settings | HUB Console';

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
}
interface PortfolioResponse {
  data: PortfolioProduct[];
}

interface RuleRow {
  id: string;
  tenant_id: string;
  product_id: string;
  alert_type: string;
  tier: 1 | 2;
  threshold_minutes: number;
  escalation_contacts: string[];
  archived_at?: string | null;
}

interface RulesResponse {
  rules: RuleRow[];
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      products: PortfolioProduct[];
      selected: PortfolioProduct | null;
      rules: RuleRow[];
    };

function rulesPath(product: PortfolioProduct, includeArchived: boolean): string {
  const base = `/api/v1/admin/escalation/${product.tenantId}/${product.productId}/rules`;
  return includeArchived ? `${base}?includeArchived=true` : base;
}

function TierBadge({ tier }: { tier: 1 | 2 }): React.ReactElement {
  return (
    <span
      data-testid={`escalation-tier-${tier}`}
      className={
        tier === 1
          ? 'inline-flex items-center rounded-full bg-primary-navy/15 px-2 py-0.5 text-xs font-body text-primary-navy'
          : 'inline-flex items-center rounded-full bg-accent-brass/15 px-2 py-0.5 text-xs font-body text-accent-brass'
      }
    >
      Tier {tier}
    </span>
  );
}

interface RuleDraft {
  alert_type: string;
  tier: 1 | 2;
  threshold_minutes: string;
  escalation_contacts: string;
}

const DEFAULT_DRAFT: RuleDraft = {
  alert_type: '',
  tier: 1,
  threshold_minutes: '30',
  escalation_contacts: '',
};

interface NewRuleModalProps {
  product: PortfolioProduct;
  defaultAlertType?: string;
  onCancel: () => void;
  onCreated: () => void;
}

function NewRuleModal({
  product,
  defaultAlertType,
  onCancel,
  onCreated,
}: NewRuleModalProps): React.ReactElement {
  const [draft, setDraft] = useState<RuleDraft>({
    ...DEFAULT_DRAFT,
    alert_type: defaultAlertType ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!draft.alert_type.trim()) nextErrors.alert_type = 'Alert type is required.';
    const minutes = parseInt(draft.threshold_minutes, 10);
    if (isNaN(minutes) || minutes <= 0) {
      nextErrors.threshold_minutes = 'Threshold minutes must be a positive integer.';
    }
    const contacts = draft.escalation_contacts
      .split(/[,\n]/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (contacts.length === 0) {
      nextErrors.escalation_contacts = 'At least one contact is required.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await apiClient.post(
        `/api/v1/admin/escalation/${product.tenantId}/${product.productId}/rules`,
        {
          alert_type: draft.alert_type.trim(),
          tier: draft.tier,
          threshold_minutes: minutes,
          escalation_contacts: contacts,
        },
      );
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
      aria-labelledby="new-rule-heading"
      data-testid="new-rule-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="new-rule-heading"
          className="mb-3 font-heading text-lg text-primary-navy"
        >
          New escalation rule
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Alert type
            <input
              data-testid="new-rule-alert-type"
              type="text"
              value={draft.alert_type}
              onChange={(e) => setDraft({ ...draft, alert_type: e.target.value })}
              aria-invalid={errors.alert_type ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.alert_type && (
              <span
                data-testid="new-rule-alert-type-err"
                className="text-xs text-ironwake"
              >
                {errors.alert_type}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Tier
            <select
              data-testid="new-rule-tier"
              value={String(draft.tier)}
              onChange={(e) =>
                setDraft({ ...draft, tier: e.target.value === '2' ? 2 : 1 })
              }
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              <option value="1">Tier 1 (fires first)</option>
              <option value="2">Tier 2 (fires after threshold)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Threshold minutes
            <input
              data-testid="new-rule-threshold"
              type="number"
              min={1}
              value={draft.threshold_minutes}
              onChange={(e) =>
                setDraft({ ...draft, threshold_minutes: e.target.value })
              }
              aria-invalid={errors.threshold_minutes ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.threshold_minutes && (
              <span
                data-testid="new-rule-threshold-err"
                className="text-xs text-ironwake"
              >
                {errors.threshold_minutes}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Contacts (comma- or newline-separated)
            <textarea
              data-testid="new-rule-contacts"
              value={draft.escalation_contacts}
              rows={3}
              placeholder="sammy@maverick.launch, oncall@maverick.launch"
              onChange={(e) =>
                setDraft({ ...draft, escalation_contacts: e.target.value })
              }
              aria-invalid={errors.escalation_contacts ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.escalation_contacts && (
              <span
                data-testid="new-rule-contacts-err"
                className="text-xs text-ironwake"
              >
                {errors.escalation_contacts}
              </span>
            )}
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="new-rule-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="new-rule-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="new-rule-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Creating…' : 'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ArchiveDialogState {
  rule: RuleRow;
  stage: 'ask' | 'confirming';
  submitting: boolean;
  errorMessage: string | null;
}

interface ArchiveDialogProps {
  state: ArchiveDialogState;
  onCancel: () => void;
  onAdvance: () => void;
  onConfirm: () => void;
}

function ArchiveDialog({
  state,
  onCancel,
  onAdvance,
  onConfirm,
}: ArchiveDialogProps): React.ReactElement {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="archive-rule-heading"
      data-testid="archive-rule-dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="archive-rule-heading"
          className="mb-2 font-heading text-lg text-primary-navy"
        >
          Archive Tier {state.rule.tier} — {state.rule.alert_type}
        </h2>
        <p className="text-sm font-body text-deep-charcoal">
          Archive this escalation rule? It will be hidden from the active list
          but preserved for audit history.
        </p>
        {state.stage === 'confirming' && (
          <div
            role="alert"
            data-testid="archive-rule-confirm-panel"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            Click <strong>Archive now</strong> once more to commit.
          </div>
        )}
        {state.errorMessage && (
          <div
            role="alert"
            data-testid="archive-rule-error"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {state.errorMessage}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="archive-rule-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="archive-rule-confirm"
            onClick={state.stage === 'ask' ? onAdvance : onConfirm}
            disabled={state.submitting}
            className="rounded bg-ironwake px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-ironwake/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {state.submitting
              ? 'Archiving…'
              : state.stage === 'ask'
                ? 'Continue to confirm'
                : 'Archive now'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EscalationManager(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [showNew, setShowNew] = useState<{ defaultAlertType?: string } | null>(
    null,
  );
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogState | null>(
    null,
  );

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const loadProducts = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await apiClient.get<PortfolioResponse>(PORTFOLIO_PATH);
      setState({
        kind: 'ready',
        products: res.data,
        selected: null,
        rules: [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load products';
      setState({ kind: 'error', message });
    }
  }, []);

  const loadRules = useCallback(
    async (product: PortfolioProduct): Promise<void> => {
      try {
        const res = await apiClient.get<RulesResponse>(
          rulesPath(product, includeArchived),
        );
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, selected: product, rules: res.rules }
            : prev,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load rules';
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, selected: product, rules: [] }
            : { kind: 'error', message },
        );
      }
    },
    [includeArchived],
  );

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const selectedProductId =
    state.kind === 'ready' ? (state.selected?.productId ?? null) : null;
  useEffect(() => {
    if (state.kind === 'ready' && state.selected) {
      void loadRules(state.selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived, selectedProductId, loadRules, state.kind]);

  const handleArchiveConfirm = useCallback(async (): Promise<void> => {
    if (!archiveDialog || state.kind !== 'ready' || !state.selected) return;
    setArchiveDialog({
      ...archiveDialog,
      submitting: true,
      errorMessage: null,
    });
    try {
      await apiClient.delete(
        `/api/v1/admin/escalation/${state.selected.tenantId}/${state.selected.productId}/rules/${archiveDialog.rule.id}`,
      );
      setArchiveDialog(null);
      void loadRules(state.selected);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Archive failed.';
      setArchiveDialog({
        ...archiveDialog,
        submitting: false,
        errorMessage: message,
      });
    }
  }, [archiveDialog, state, loadRules]);

  const rulesByAlertType = useMemo(() => {
    if (state.kind !== 'ready') return new Map<string, RuleRow[]>();
    const map = new Map<string, RuleRow[]>();
    for (const r of state.rules) {
      const list = map.get(r.alert_type) ?? [];
      list.push(r);
      map.set(r.alert_type, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.tier - b.tier);
    return map;
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div id="main-content" data-testid="escalation-page">
        <div
          data-testid="escalation-skeleton"
          className="h-32 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="escalation-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load escalation rules.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="escalation-retry"
          onClick={() => void loadProducts()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div id="main-content" data-testid="escalation-page" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">Escalation</h1>
        <p className="text-sm font-body text-deep-charcoal/70">
          Per-product escalation rules, up to two tiers per alert type. Tier 1
          fires first; Tier 2 fires after the threshold elapses.
        </p>
      </header>

      <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
        Product
        <select
          data-testid="escalation-product-picker"
          value={state.selected?.productId ?? ''}
          onChange={(e) => {
            const product = state.products.find(
              (p) => p.productId === e.target.value,
            );
            if (product) void loadRules(product);
          }}
          className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          <option value="">Select a product…</option>
          {state.products.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.productName}
            </option>
          ))}
        </select>
      </label>

      {state.selected && (
        <>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
              <input
                type="checkbox"
                data-testid="escalation-show-archived"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              Show archived
            </label>
            <button
              type="button"
              data-testid="escalation-new"
              onClick={() => setShowNew({})}
              className="rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              New rule
            </button>
          </div>

          {state.rules.length === 0 ? (
            <div
              data-testid="escalation-empty"
              className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
            >
              No escalation rules for this product yet. Click{' '}
              <strong>New rule</strong> to add one.
            </div>
          ) : (
            <ul
              data-testid="escalation-list"
              className="flex flex-col gap-3"
            >
              {Array.from(rulesByAlertType.entries()).map(([alertType, list]) => (
                <li
                  key={alertType}
                  data-testid={`escalation-group-${alertType}`}
                  className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="font-heading text-base text-primary-navy">
                      {alertType}
                    </p>
                    {list.length < 2 && (
                      <button
                        type="button"
                        data-testid={`escalation-add-${alertType}`}
                        onClick={() =>
                          setShowNew({ defaultAlertType: alertType })
                        }
                        className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      >
                        Add tier
                      </button>
                    )}
                  </div>
                  <ul className="flex flex-col gap-2">
                    {list.map((r) => (
                      <li
                        key={r.id}
                        data-testid={`escalation-row-${r.id}`}
                        className={
                          r.archived_at
                            ? 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/10 bg-deep-charcoal/5 p-2'
                            : 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/10 bg-sailcloth p-2'
                        }
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <TierBadge tier={r.tier} />
                            <span className="text-xs font-body text-deep-charcoal/70">
                              fires after {r.threshold_minutes} min
                            </span>
                          </div>
                          <p className="mt-1 text-xs font-body text-deep-charcoal/60">
                            Contacts: {r.escalation_contacts.join(', ') || '—'}
                          </p>
                        </div>
                        {!r.archived_at && (
                          <button
                            type="button"
                            data-testid={`escalation-archive-${r.id}`}
                            onClick={() =>
                              setArchiveDialog({
                                rule: r,
                                stage: 'ask',
                                submitting: false,
                                errorMessage: null,
                              })
                            }
                            className="rounded border border-ironwake/40 px-2 py-1 text-xs font-body text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                          >
                            Archive
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {showNew && state.selected && (
        <NewRuleModal
          product={state.selected}
          defaultAlertType={showNew.defaultAlertType}
          onCancel={() => setShowNew(null)}
          onCreated={() => {
            setShowNew(null);
            if (state.selected) void loadRules(state.selected);
          }}
        />
      )}
      {archiveDialog && (
        <ArchiveDialog
          state={archiveDialog}
          onCancel={() => setArchiveDialog(null)}
          onAdvance={() =>
            setArchiveDialog({ ...archiveDialog, stage: 'confirming' })
          }
          onConfirm={() => void handleArchiveConfirm()}
        />
      )}
    </div>
  );
}
