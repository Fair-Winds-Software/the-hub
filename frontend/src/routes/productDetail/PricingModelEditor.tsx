// Authorized by HUB-1654 (E-FE-5 S4) — Pricing model editor at
// /console/products/:productId/pricing. Fetches the active pricing model
// via the verified BE surface, renders an editable tier table + margin-
// floor field + cost matrix, pre-validates client-side, and PUTs on save
// with field-level 422 rendering. Draft persists in localStorage per
// productId so an accidental tab close doesn't lose in-flight work.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. tenantId source: the FE has the productId in the URL but the BE
//      pricing routes are tenant-scoped
//      (GET/PUT /api/v1/admin/tenants/:tenantId/products/:productId/pricing).
//      We resolve tenantId via the HUB-1700 /portfolio/products aggregator
//      (same lookup pattern as ProductDetail.tsx). If the product is out
//      of scope for the operator, the portfolio call returns an empty
//      list → we render <AccessDeniedPage>, matching HUB-1609 pattern.
//
//   2. Active subscribers banner: the story asked us to call
//      analyticsService.getBillingAnalytics for the activeSubscribers
//      count, but no HTTP surface for that exists at v0.1 (grep confirms
//      no /analytics/billing route). We render a generic "grandfathering
//      warning" banner with no numeric count — the wording still
//      contextualizes blast radius per the spec's intent. Tracked as
//      HUB-1545 tech debt candidate: expose a /billing-analytics endpoint
//      OR fold the count into the pricing GET response.
//
//   3. Cost matrix: the story described a per-input-dimension cost
//      matrix. Real BE pricing_model_row.config is a freeform JSONB blob;
//      we surface it as an editable JSON textarea (with syntax
//      validation) so operators can hand-edit config without the FE
//      forcing a specific matrix shape. This is the same pragmatic
//      approach used by other config-heavy admin editors in the codebase
//      (SdkVersions per-product settings).
//
//   4. Route: mounted at /console/products/:productId/pricing under the
//      same product_admin GuardedRoute as the product detail. Server
//      returns 403 for out-of-scope productId → PermissionDeniedError →
//      <AccessDeniedPage>.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';
import { AccessDeniedPage } from '../../components/AccessDeniedPage';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Pricing model | HUB Console';

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
}

interface PortfolioResponse {
  data: PortfolioProduct[];
}

interface TierRow {
  tier_order: number;
  up_to_units: number | null;
  unit_price_cents: number;
  flat_fee_cents: number;
}

interface PricingModelResponse {
  model_id?: string;
  product_id: string;
  model_type: string;
  currency: string;
  config: Record<string, unknown>;
  tiers?: TierRow[];
  activated_at?: string | null;
}

interface FieldErrors {
  [fieldPath: string]: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not-found' }
  | { kind: 'denied' }
  | { kind: 'ready'; product: PortfolioProduct; model: PricingModelResponse | null };

function draftKey(productId: string): string {
  return `pricingModelEditor.draft.${productId}`;
}

function safeParseJson(input: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: 'config must be a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON';
    return { ok: false, message };
  }
}

interface EditableDraft {
  modelType: string;
  currency: string;
  configJson: string;
  tiers: Array<{ up_to_units: string; unit_price_cents: string; flat_fee_cents: string }>;
  marginFloorCents: string;
  bannerDismissed: boolean;
}

function makeInitialDraft(model: PricingModelResponse | null): EditableDraft {
  return {
    modelType: model?.model_type ?? 'flat',
    currency: model?.currency ?? 'usd',
    configJson: model?.config ? JSON.stringify(model.config, null, 2) : '{}',
    tiers: (model?.tiers ?? []).map((t) => ({
      up_to_units: t.up_to_units === null ? '' : String(t.up_to_units),
      unit_price_cents: String(t.unit_price_cents),
      flat_fee_cents: String(t.flat_fee_cents),
    })),
    marginFloorCents:
      typeof model?.config?.margin_floor_cents === 'number'
        ? String(model.config.margin_floor_cents)
        : '',
    bannerDismissed: false,
  };
}

function loadDraft(productId: string): EditableDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(productId));
    if (!raw) return null;
    return JSON.parse(raw) as EditableDraft;
  } catch {
    return null;
  }
}

function saveDraft(productId: string, draft: EditableDraft): void {
  try {
    localStorage.setItem(draftKey(productId), JSON.stringify(draft));
  } catch {
    // localStorage full / disabled — draft not persisted, editor still works.
  }
}

function clearDraft(productId: string): void {
  try {
    localStorage.removeItem(draftKey(productId));
  } catch {
    // no-op
  }
}

function pricingGetUrl(tenantId: string, productId: string): string {
  return `/api/v1/admin/tenants/${tenantId}/products/${productId}/pricing`;
}
function pricingPutUrl(tenantId: string, productId: string): string {
  return `/api/v1/admin/tenants/${tenantId}/products/${productId}/pricing`;
}

interface ValidationResult {
  errors: FieldErrors;
  parsedConfig: Record<string, unknown> | null;
  parsedTiers: TierRow[];
}

function validateDraft(draft: EditableDraft): ValidationResult {
  const errors: FieldErrors = {};
  if (!draft.modelType.trim()) {
    errors.modelType = 'Model type is required.';
  }
  if (!draft.currency.trim()) {
    errors.currency = 'Currency is required.';
  }

  const configParse = safeParseJson(draft.configJson);
  const parsedConfig: Record<string, unknown> | null = configParse.ok
    ? configParse.value
    : null;
  if (!configParse.ok) {
    errors.config = configParse.message;
  }

  // Tiers.
  const parsedTiers: TierRow[] = [];
  let prevUpTo: number | null = 0;
  draft.tiers.forEach((t, i) => {
    const unit = parseInt(t.unit_price_cents, 10);
    if (isNaN(unit) || unit < 0) {
      errors[`tiers.${i}.unit_price_cents`] =
        'Unit price must be a non-negative integer (cents).';
    }
    const flat = parseInt(t.flat_fee_cents, 10);
    if (isNaN(flat) || flat < 0) {
      errors[`tiers.${i}.flat_fee_cents`] =
        'Flat fee must be a non-negative integer (cents).';
    }
    let upTo: number | null;
    if (t.up_to_units.trim() === '') {
      upTo = null;
    } else {
      upTo = parseInt(t.up_to_units, 10);
      if (isNaN(upTo) || upTo <= 0) {
        errors[`tiers.${i}.up_to_units`] =
          'Up-to units must be a positive integer or empty (unbounded).';
      } else if (prevUpTo !== null && upTo <= prevUpTo) {
        errors[`tiers.${i}.up_to_units`] =
          'Tier upper bounds must be strictly increasing.';
      }
    }
    parsedTiers.push({
      tier_order: i,
      up_to_units: upTo,
      unit_price_cents: isNaN(unit) ? 0 : unit,
      flat_fee_cents: isNaN(flat) ? 0 : flat,
    });
    prevUpTo = upTo;
  });

  // Margin floor: if provided, ensure every tier's unit_price >= floor.
  if (draft.marginFloorCents.trim().length > 0) {
    const floor = parseInt(draft.marginFloorCents, 10);
    if (isNaN(floor) || floor < 0) {
      errors.marginFloorCents =
        'Margin floor must be a non-negative integer (cents).';
    } else {
      parsedTiers.forEach((t, i) => {
        if (t.unit_price_cents < floor) {
          errors[`tiers.${i}.unit_price_cents`] =
            `Unit price is below the margin floor (${floor}¢).`;
        }
      });
    }
  }

  return { errors, parsedConfig, parsedTiers };
}

function formatUSD(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function ActiveSubscribersBanner({
  productName,
  onDismiss,
}: {
  productName: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div
      role="status"
      data-testid="pricing-editor-subscribers-banner"
      className="flex items-start justify-between gap-3 rounded-md border border-accent-brass/40 bg-accent-brass/5 p-3 text-sm font-body text-accent-brass"
    >
      <p>
        Pricing changes for <strong>{productName}</strong> apply immediately
        for new invoices; existing subscriptions will be grandfathered per
        plan-change-service rules.
      </p>
      <button
        type="button"
        data-testid="pricing-editor-subscribers-banner-dismiss"
        onClick={onDismiss}
        className="shrink-0 text-xs underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        Dismiss
      </button>
    </div>
  );
}

interface TierEditorProps {
  tiers: EditableDraft['tiers'];
  errors: FieldErrors;
  onChange: (tiers: EditableDraft['tiers']) => void;
}

function TierEditor({ tiers, errors, onChange }: TierEditorProps): React.ReactElement {
  const patchRow = (idx: number, patch: Partial<EditableDraft['tiers'][number]>): void => {
    const next = tiers.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange(next);
  };
  const addRow = (): void => {
    onChange([
      ...tiers,
      { up_to_units: '', unit_price_cents: '0', flat_fee_cents: '0' },
    ]);
  };
  const removeRow = (idx: number): void => {
    onChange(tiers.filter((_, i) => i !== idx));
  };
  return (
    <div className="flex flex-col gap-2" data-testid="pricing-editor-tiers">
      <div className="flex items-baseline justify-between">
        <h2 className="font-heading text-lg text-primary-navy">Tiers</h2>
        <button
          type="button"
          data-testid="pricing-editor-tier-add"
          onClick={addRow}
          className="rounded border border-primary-navy/40 px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Add tier
        </button>
      </div>
      {tiers.length === 0 && (
        <p
          data-testid="pricing-editor-tiers-empty"
          className="text-sm font-body text-deep-charcoal/60"
        >
          No tiers defined. Add a tier to price this model by unit volume.
        </p>
      )}
      {tiers.map((t, i) => {
        const upToErr = errors[`tiers.${i}.up_to_units`];
        const unitErr = errors[`tiers.${i}.unit_price_cents`];
        const flatErr = errors[`tiers.${i}.flat_fee_cents`];
        return (
          <div
            key={i}
            data-testid={`pricing-editor-tier-row-${i}`}
            className="grid grid-cols-1 gap-2 rounded border border-deep-charcoal/10 p-3 md:grid-cols-4 md:items-end"
          >
            <label className="flex flex-col gap-1 text-xs font-body text-deep-charcoal/80">
              Up to units
              <input
                data-testid={`pricing-editor-tier-up-to-${i}`}
                type="text"
                inputMode="numeric"
                value={t.up_to_units}
                placeholder="unbounded"
                onChange={(e) =>
                  patchRow(i, { up_to_units: e.target.value })
                }
                aria-invalid={upToErr ? true : undefined}
                aria-describedby={upToErr ? `tier-${i}-up-to-err` : undefined}
                className="rounded border border-deep-charcoal/20 p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              />
              {upToErr && (
                <span
                  id={`tier-${i}-up-to-err`}
                  data-testid={`pricing-editor-tier-up-to-err-${i}`}
                  className="text-xs text-ironwake"
                >
                  {upToErr}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-xs font-body text-deep-charcoal/80">
              Unit price (cents)
              <input
                data-testid={`pricing-editor-tier-unit-${i}`}
                type="text"
                inputMode="numeric"
                value={t.unit_price_cents}
                onChange={(e) =>
                  patchRow(i, { unit_price_cents: e.target.value })
                }
                aria-invalid={unitErr ? true : undefined}
                aria-describedby={unitErr ? `tier-${i}-unit-err` : undefined}
                className="rounded border border-deep-charcoal/20 p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              />
              <span className="text-[0.65rem] text-deep-charcoal/50">
                {formatUSD(parseInt(t.unit_price_cents, 10) || 0)}
              </span>
              {unitErr && (
                <span
                  id={`tier-${i}-unit-err`}
                  data-testid={`pricing-editor-tier-unit-err-${i}`}
                  className="text-xs text-ironwake"
                >
                  {unitErr}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-xs font-body text-deep-charcoal/80">
              Flat fee (cents)
              <input
                data-testid={`pricing-editor-tier-flat-${i}`}
                type="text"
                inputMode="numeric"
                value={t.flat_fee_cents}
                onChange={(e) =>
                  patchRow(i, { flat_fee_cents: e.target.value })
                }
                aria-invalid={flatErr ? true : undefined}
                aria-describedby={flatErr ? `tier-${i}-flat-err` : undefined}
                className="rounded border border-deep-charcoal/20 p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              />
              {flatErr && (
                <span
                  id={`tier-${i}-flat-err`}
                  data-testid={`pricing-editor-tier-flat-err-${i}`}
                  className="text-xs text-ironwake"
                >
                  {flatErr}
                </span>
              )}
            </label>
            <button
              type="button"
              data-testid={`pricing-editor-tier-remove-${i}`}
              onClick={() => removeRow(i)}
              className="rounded border border-ironwake/40 px-2 py-1 text-xs text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Remove tier
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default function PricingModelEditor(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [draft, setDraft] = useState<EditableDraft>(() => makeInitialDraft(null));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveStatus, setSaveStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'success' }
    | { kind: 'server-error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const portfolio = await apiClient.get<PortfolioResponse>(PORTFOLIO_PATH);
      const product = portfolio.data.find((p) => p.productId === productId);
      if (!product) {
        setState({ kind: 'denied' });
        return;
      }
      let model: PricingModelResponse | null = null;
      try {
        model = await apiClient.get<PricingModelResponse>(
          pricingGetUrl(product.tenantId, productId),
        );
      } catch (err) {
        if (err instanceof Error && /404|not found/i.test(err.message)) {
          model = null;
        } else if (err instanceof PermissionDeniedError) {
          setState({ kind: 'denied' });
          return;
        } else {
          throw err;
        }
      }
      const seeded = loadDraft(productId) ?? makeInitialDraft(model);
      setDraft(seeded);
      setState({ kind: 'ready', product, model });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to load pricing model';
      setState({ kind: 'error', message });
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.kind === 'ready') saveDraft(productId, draft);
  }, [draft, productId, state.kind]);

  const handleSave = useCallback(async () => {
    if (state.kind !== 'ready') return;
    const validation = validateDraft(draft);
    setErrors(validation.errors);
    if (Object.keys(validation.errors).length > 0) return;
    setSaveStatus({ kind: 'saving' });
    try {
      const configWithFloor = {
        ...(validation.parsedConfig ?? {}),
      };
      if (draft.marginFloorCents.trim().length > 0) {
        configWithFloor.margin_floor_cents = parseInt(draft.marginFloorCents, 10);
      }
      await apiClient.put(
        pricingPutUrl(state.product.tenantId, productId),
        {
          modelType: draft.modelType,
          currency: draft.currency,
          config: configWithFloor,
          tiers: validation.parsedTiers,
        },
      );
      clearDraft(productId);
      setSaveStatus({ kind: 'success' });
      // Re-hydrate to reflect server-normalized state.
      void load();
    } catch (err) {
      if (err instanceof Error) {
        // Attempt to surface field errors from a 422 body.
        const match = /"errors"\s*:\s*(\{[\s\S]*?\})/.exec(err.message);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]!) as FieldErrors;
            setErrors(parsed);
            setSaveStatus({ kind: 'idle' });
            return;
          } catch {
            // fall through
          }
        }
        setSaveStatus({ kind: 'server-error', message: err.message });
      } else {
        setSaveStatus({ kind: 'server-error', message: 'Save failed.' });
      }
    }
  }, [draft, productId, state, load]);

  const handleDiscard = useCallback(() => {
    if (state.kind !== 'ready') return;
    clearDraft(productId);
    setDraft(makeInitialDraft(state.model));
    setErrors({});
    setSaveStatus({ kind: 'idle' });
  }, [productId, state]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="pricing-editor-page"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="pricing-editor-skeleton"
          className="h-72 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }

  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="this product's pricing"
          backTo="/console/products"
          backLabel="Back to products"
        />
      </div>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <div
        id="main-content"
        data-testid="pricing-editor-not-found"
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal"
      >
        <p className="font-medium">Product not found.</p>
        <Link
          to="/console/products"
          className="mt-2 inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Back to products
        </Link>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="pricing-editor-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load the pricing model.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="pricing-editor-retry"
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
      data-testid="pricing-editor-page"
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">
          Pricing model — {state.product.productName}
        </h1>
        <Link
          to={`/console/products/${productId}`}
          className="w-fit text-xs font-body text-primary-navy underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          ← Back to product
        </Link>
      </header>

      {!draft.bannerDismissed && (
        <ActiveSubscribersBanner
          productName={state.product.productName}
          onDismiss={() => setDraft({ ...draft, bannerDismissed: true })}
        />
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
          Model type
          <input
            data-testid="pricing-editor-model-type"
            type="text"
            value={draft.modelType}
            onChange={(e) => setDraft({ ...draft, modelType: e.target.value })}
            aria-invalid={errors.modelType ? true : undefined}
            className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
          />
          {errors.modelType && (
            <span
              data-testid="pricing-editor-model-type-err"
              className="text-xs text-ironwake"
            >
              {errors.modelType}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
          Currency
          <input
            data-testid="pricing-editor-currency"
            type="text"
            value={draft.currency}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
            aria-invalid={errors.currency ? true : undefined}
            className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
          />
          {errors.currency && (
            <span
              data-testid="pricing-editor-currency-err"
              className="text-xs text-ironwake"
            >
              {errors.currency}
            </span>
          )}
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
        Margin floor (cents)
        <input
          data-testid="pricing-editor-margin-floor"
          type="text"
          inputMode="numeric"
          value={draft.marginFloorCents}
          onChange={(e) =>
            setDraft({ ...draft, marginFloorCents: e.target.value })
          }
          aria-invalid={errors.marginFloorCents ? true : undefined}
          className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        />
        {draft.marginFloorCents && (
          <span className="text-xs text-deep-charcoal/60">
            = {formatUSD(parseInt(draft.marginFloorCents, 10) || 0)}
          </span>
        )}
        {errors.marginFloorCents && (
          <span
            data-testid="pricing-editor-margin-floor-err"
            className="text-xs text-ironwake"
          >
            {errors.marginFloorCents}
          </span>
        )}
      </label>

      <TierEditor
        tiers={draft.tiers}
        errors={errors}
        onChange={(next) => setDraft({ ...draft, tiers: next })}
      />

      <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
        Config JSON (cost matrix + arbitrary model config)
        <textarea
          data-testid="pricing-editor-config-json"
          value={draft.configJson}
          rows={10}
          onChange={(e) => setDraft({ ...draft, configJson: e.target.value })}
          aria-invalid={errors.config ? true : undefined}
          className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        />
        {errors.config && (
          <span
            data-testid="pricing-editor-config-err"
            className="text-xs text-ironwake"
          >
            {errors.config}
          </span>
        )}
      </label>

      {saveStatus.kind === 'success' && (
        <div
          role="status"
          data-testid="pricing-editor-save-success"
          className="rounded-md border border-seafoam/40 bg-seafoam/5 p-3 text-sm font-body text-seafoam"
        >
          Pricing model saved.
        </div>
      )}
      {saveStatus.kind === 'server-error' && (
        <div
          role="alert"
          data-testid="pricing-editor-save-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          {saveStatus.message}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="pricing-editor-save"
          onClick={() => void handleSave()}
          disabled={saveStatus.kind === 'saving'}
          className="inline-flex items-center rounded-md bg-primary-navy px-4 py-2 text-sm font-body text-sailcloth shadow-sm hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          {saveStatus.kind === 'saving' ? 'Saving…' : 'Save pricing model'}
        </button>
        <button
          type="button"
          data-testid="pricing-editor-discard"
          onClick={handleDiscard}
          className="inline-flex items-center rounded-md border border-deep-charcoal/20 px-3 py-2 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Discard changes
        </button>
      </div>
    </div>
  );
}
