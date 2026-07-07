// Authorized by HUB-1746 + HUB-1747 (E-V2-PP-3 S6/S7, HUB-1727, HUB-1701) —
// dimensions list + per-tier overage-rate matrix + inline usage preview widget.
// Rendered inside the EditPlanModal in PlansManager for plans with billing_type='tiered'.
//
// State ownership sits in the parent (EditPlanModal); these components take controlled
// props for the dimensions[], tiers[] with nested overage_rates, and per-cell mutations.

import { useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';

export interface Dimension {
  dimension_key: string;
  dimension_label: string;
  sort_order: number;
}

export interface OverageRate {
  dimension_key: string;
  included_quantity: number;
  rate_per_unit_cents: number;
}

export interface TierWithOverage {
  upTo?: number | null;
  unitAmount?: number;
  overage_rates?: OverageRate[];
}

const SNAKE_CASE = /^[a-z][a-z0-9_]{2,63}$/;

// ─── OverageMatrix (HUB-1746) ────────────────────────────────────────────────

interface OverageMatrixProps {
  readOnly: boolean;
  dimensions: Dimension[];
  tiers: TierWithOverage[];
  onDimensionsChange: (next: Dimension[]) => void;
  onTiersChange: (next: TierWithOverage[]) => void;
}

/** Returns overage rate for (tier_index, dimension_key) or defaults. */
function findRate(tier: TierWithOverage, dimensionKey: string): OverageRate {
  const found = tier.overage_rates?.find((r) => r.dimension_key === dimensionKey);
  return found ?? { dimension_key: dimensionKey, included_quantity: 0, rate_per_unit_cents: 0 };
}

export function validateDimensions(dimensions: Dimension[]): Array<string | null> {
  const errors: Array<string | null> = dimensions.map(() => null);
  const seenKeys = new Set<string>();
  dimensions.forEach((d, i) => {
    if (!SNAKE_CASE.test(d.dimension_key)) {
      errors[i] = 'dimension_key must be snake_case (3–64 chars).';
    } else if (seenKeys.has(d.dimension_key)) {
      errors[i] = 'Duplicate dimension_key.';
    } else if (d.dimension_label.trim().length === 0) {
      errors[i] = 'dimension_label is required.';
    }
    seenKeys.add(d.dimension_key);
  });
  return errors;
}

export function OverageMatrix({
  readOnly,
  dimensions,
  tiers,
  onDimensionsChange,
  onTiersChange,
}: OverageMatrixProps): React.ReactElement {
  const dimErrors = useMemo(() => validateDimensions(dimensions), [dimensions]);

  const addDimension = (): void => {
    const nextKey = `dim_${dimensions.length + 1}`;
    const nextSort = dimensions.length === 0 ? 0 : Math.max(...dimensions.map((d) => d.sort_order)) + 1;
    onDimensionsChange([
      ...dimensions,
      { dimension_key: nextKey, dimension_label: nextKey, sort_order: nextSort },
    ]);
  };

  const updateDimension = (idx: number, patch: Partial<Dimension>): void => {
    onDimensionsChange(dimensions.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  const removeDimension = (idx: number): void => {
    const removedKey = dimensions[idx]!.dimension_key;
    onDimensionsChange(dimensions.filter((_, i) => i !== idx));
    // Also strip the dimension from all tiers' overage_rates.
    onTiersChange(
      tiers.map((t) => ({
        ...t,
        overage_rates: t.overage_rates?.filter((r) => r.dimension_key !== removedKey),
      })),
    );
  };

  const updateCell = (
    tierIdx: number,
    dimKey: string,
    patch: Partial<Pick<OverageRate, 'included_quantity' | 'rate_per_unit_cents'>>,
  ): void => {
    const tier = tiers[tierIdx];
    if (!tier) return;
    const existing = tier.overage_rates ?? [];
    const idx = existing.findIndex((r) => r.dimension_key === dimKey);
    const currentRate = idx === -1 ? findRate(tier, dimKey) : existing[idx]!;
    const nextRate: OverageRate = { ...currentRate, ...patch };
    const nextRates = idx === -1 ? [...existing, nextRate] : existing.map((r, i) => (i === idx ? nextRate : r));
    onTiersChange(tiers.map((t, i) => (i === tierIdx ? { ...t, overage_rates: nextRates } : t)));
  };

  return (
    <div className="flex flex-col gap-3" data-testid="overage-matrix">
      <div>
        <span className="text-sm font-body text-deep-charcoal/80">Metered dimensions</span>
        {dimensions.length === 0 && (
          <p className="text-xs text-deep-charcoal/60">No dimensions declared yet. Add one below.</p>
        )}
        <div className="mt-2 flex flex-col gap-1">
          {dimensions.map((d, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                <input
                  data-testid={`dimension-key-${i}`}
                  type="text"
                  readOnly={readOnly}
                  value={d.dimension_key}
                  onChange={(e) => updateDimension(i, { dimension_key: e.target.value })}
                  placeholder="dimension_key"
                  className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                />
                <input
                  data-testid={`dimension-label-${i}`}
                  type="text"
                  readOnly={readOnly}
                  value={d.dimension_label}
                  onChange={(e) => updateDimension(i, { dimension_label: e.target.value })}
                  placeholder="Display label"
                  className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                />
                {!readOnly && (
                  <button
                    type="button"
                    data-testid={`dimension-remove-${i}`}
                    onClick={() => removeDimension(i)}
                    aria-label={`Remove dimension ${d.dimension_key}`}
                    className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs text-deep-charcoal hover:bg-deep-charcoal/5"
                  >
                    ×
                  </button>
                )}
              </div>
              {dimErrors[i] && (
                <span
                  role="alert"
                  data-testid={`dimension-error-${i}`}
                  className="text-xs text-error-crimson"
                >
                  {dimErrors[i]}
                </span>
              )}
            </div>
          ))}
        </div>
        {!readOnly && (
          <button
            type="button"
            data-testid="dimension-add"
            onClick={addDimension}
            className="mt-2 rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5"
          >
            + Add dimension
          </button>
        )}
      </div>

      {dimensions.length > 0 && tiers.length > 0 && (
        <div>
          <span className="text-sm font-body text-deep-charcoal/80">
            Overage rates by tier
          </span>
          <table className="mt-2 w-full text-xs font-body" data-testid="overage-matrix-table">
            <thead>
              <tr className="text-left text-deep-charcoal/70">
                <th className="pr-2 pb-1">Dimension</th>
                {tiers.map((_, ti) => (
                  <th key={ti} className="pr-2 pb-1">Tier {ti + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dimensions.map((d) => (
                <tr key={d.dimension_key} data-testid={`matrix-row-${d.dimension_key}`}>
                  <td className="pr-2 py-1 text-deep-charcoal">{d.dimension_label}</td>
                  {tiers.map((t, ti) => {
                    const rate = findRate(t, d.dimension_key);
                    return (
                      <td key={ti} className="pr-2 py-1">
                        <div className="flex flex-col gap-1">
                          <input
                            data-testid={`matrix-included-${d.dimension_key}-${ti}`}
                            type="number"
                            min={0}
                            readOnly={readOnly}
                            value={rate.included_quantity}
                            onChange={(e) => updateCell(ti, d.dimension_key, {
                              included_quantity: parseInt(e.target.value, 10) || 0,
                            })}
                            className="w-20 rounded border border-deep-charcoal/20 p-1 text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                          />
                          <input
                            data-testid={`matrix-rate-${d.dimension_key}-${ti}`}
                            type="number"
                            min={0}
                            readOnly={readOnly}
                            value={rate.rate_per_unit_cents}
                            onChange={(e) => updateCell(ti, d.dimension_key, {
                              rate_per_unit_cents: parseInt(e.target.value, 10) || 0,
                            })}
                            placeholder="¢/unit"
                            className="w-20 rounded border border-deep-charcoal/20 p-1 text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                          />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── OveragePreview (HUB-1747) ───────────────────────────────────────────────

interface OveragePreviewProps {
  planId: string;
  /** Draft dimensions + tiers to preview against; if omitted, uses the currently saved plan. */
  dimensions?: Dimension[];
  tiers?: TierWithOverage[];
}

interface PreviewRow {
  tenant_id: string;
  tenant_name: string;
  total_overage_cents: number;
}

interface PreviewResponse {
  tenants_over: number;
  total_overage_cents: number;
  biggest_impact?: PreviewRow;
  per_tenant: PreviewRow[];
}

const formatCurrency = (cents: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export function OveragePreview({
  planId,
  dimensions,
  tiers,
}: OveragePreviewProps): React.ReactElement {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; data: PreviewResponse }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [expanded, setExpanded] = useState(false);

  const runSimulate = async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const payload: Record<string, unknown> = { plan_id: planId };
      if (dimensions !== undefined) payload['dimensions'] = dimensions;
      if (tiers !== undefined) payload['tiers'] = tiers;
      const data = await apiClient.post<PreviewResponse>(
        '/api/v1/admin/pricing/simulate',
        payload,
      );
      setState({ kind: 'ready', data });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Simulation failed.' });
    }
  };

  return (
    <div
      className="flex flex-col gap-2 rounded border border-deep-charcoal/15 p-3"
      data-testid="overage-preview"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-body text-deep-charcoal/80">Usage preview</span>
        <button
          type="button"
          data-testid="overage-preview-run"
          onClick={() => void runSimulate()}
          disabled={state.kind === 'loading'}
          className="rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 disabled:opacity-50"
        >
          {state.kind === 'loading' ? 'Running…' : 'Run preview'}
        </button>
      </div>
      {state.kind === 'error' && (
        <p role="alert" data-testid="overage-preview-error" className="text-xs text-error-crimson">
          {state.message}
        </p>
      )}
      {state.kind === 'ready' && (
        <div className="flex flex-col gap-1" data-testid="overage-preview-summary">
          <p className="text-xs text-deep-charcoal">
            <strong>{state.data.tenants_over}</strong> tenant(s) with projected overage; total{' '}
            <strong>{formatCurrency(state.data.total_overage_cents)}</strong>.
          </p>
          {state.data.biggest_impact !== undefined && (
            <p className="text-xs text-deep-charcoal/80">
              Biggest impact: {state.data.biggest_impact.tenant_name} —{' '}
              {formatCurrency(state.data.biggest_impact.total_overage_cents)}
            </p>
          )}
          <button
            type="button"
            data-testid="overage-preview-toggle"
            onClick={() => setExpanded((e) => !e)}
            className="self-start text-xs font-body text-primary-navy underline"
          >
            {expanded ? 'Hide' : 'See'} per-tenant breakdown
          </button>
          {expanded && (
            <ul className="mt-1 flex flex-col gap-1" data-testid="overage-preview-list">
              {state.data.per_tenant.map((r) => (
                <li key={r.tenant_id} className="text-xs text-deep-charcoal">
                  {r.tenant_name}: {formatCurrency(r.total_overage_cents)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
