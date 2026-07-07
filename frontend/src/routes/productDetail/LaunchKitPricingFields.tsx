// Authorized by HUB-1722 + HUB-1724 (E-V2-PP-1 S9/S11, HUB-1713, HUB-1701) —
// LaunchKit pricing fields (volume-ladder editor + first-N-free quantity-metered fields)
// rendered inside the existing PlansManager EditPlanModal. Both fields are hidden by
// default and only shown when the plan shape warrants:
//   - VolumeLadderEditor: visible ONLY when plan.billing_type='one_time'
//   - QuantityMeteredFields: visible ONLY when the operator selects a dimension
//
// Component is dumb: takes controlled state + validation error strings from the parent.
// The parent (EditPlanModal) owns the actual state + submit.

import { useMemo } from 'react';
import type { VolumeLadderTier } from './PlansManager';

/** HUB-1724 (E-V2-PP-1 S11) — Small allowed set for v0.2; matches migration 071 regex. */
const QUANTITY_METERED_DIMENSIONS = ['environment', 'app', 'seat'] as const;

// ─── VolumeLadderEditor (HUB-1722) ─────────────────────────────────────────

interface VolumeLadderEditorProps {
  readOnly: boolean;
  ladder: VolumeLadderTier[];
  onChange: (next: VolumeLadderTier[]) => void;
}

/**
 * Returns a per-index error string for each ladder row, or null. Errors:
 *   - min_quantity < 1
 *   - max_quantity !== null && max_quantity < min_quantity
 *   - overlap with another row's [min_quantity, max_quantity ?? ∞] range
 */
export function validateLadder(ladder: VolumeLadderTier[]): Array<string | null> {
  const errors: Array<string | null> = ladder.map(() => null);
  ladder.forEach((tier, i) => {
    if (!Number.isInteger(tier.min_quantity) || tier.min_quantity < 1) {
      errors[i] = 'Min quantity must be ≥ 1.';
      return;
    }
    if (tier.max_quantity !== null && tier.max_quantity < tier.min_quantity) {
      errors[i] = 'Max quantity must be ≥ min quantity (or leave blank for open-ended).';
      return;
    }
  });
  // Overlap check: sort by min ascending, look for range collisions.
  const sorted = ladder.map((t, i) => ({ t, i })).sort((a, b) => a.t.min_quantity - b.t.min_quantity);
  for (let n = 0; n < sorted.length - 1; n++) {
    const cur = sorted[n]!;
    const nxt = sorted[n + 1]!;
    const curUpper = cur.t.max_quantity ?? Infinity;
    if (curUpper >= nxt.t.min_quantity) {
      if (errors[cur.i] === null) errors[cur.i] = 'Overlaps with another tier range.';
      if (errors[nxt.i] === null) errors[nxt.i] = 'Overlaps with another tier range.';
    }
  }
  return errors;
}

export function VolumeLadderEditor({
  readOnly,
  ladder,
  onChange,
}: VolumeLadderEditorProps): React.ReactElement {
  const errors = useMemo(() => validateLadder(ladder), [ladder]);

  const addRow = (): void => {
    const nextSort = ladder.length === 0 ? 0 : Math.max(...ladder.map((t) => t.sort_order)) + 1;
    const nextMin = ladder.length === 0 ? 1 : Math.max(...ladder.map((t) => t.max_quantity ?? t.min_quantity)) + 1;
    onChange([
      ...ladder,
      { min_quantity: nextMin, max_quantity: nextMin, unit_amount_cents: 0, sort_order: nextSort },
    ]);
  };

  const updateRow = (idx: number, patch: Partial<VolumeLadderTier>): void => {
    onChange(ladder.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  };

  const removeRow = (idx: number): void => {
    onChange(ladder.filter((_, i) => i !== idx));
  };

  if (ladder.length === 0) {
    return (
      <div className="rounded border border-dashed border-deep-charcoal/30 p-3">
        <p className="text-xs font-body text-deep-charcoal/70">
          Flat pricing (no ladder). Volume-discount pricing? Add a first tier.
        </p>
        {!readOnly && (
          <button
            type="button"
            data-testid="volume-ladder-add-first"
            onClick={addRow}
            className="mt-2 rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            + Add first tier
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="volume-ladder-editor">
      <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs font-body text-deep-charcoal/70">
        <span>Min qty</span>
        <span>Max qty (blank = ∞)</span>
        <span>Unit amount (cents)</span>
        <span aria-hidden="true"></span>
      </div>
      {ladder.map((tier, idx) => (
        <div key={idx} className="flex flex-col gap-1">
          <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
            <input
              data-testid={`volume-ladder-row-${idx}-min`}
              type="number"
              min={1}
              readOnly={readOnly}
              value={tier.min_quantity}
              onChange={(e) => updateRow(idx, { min_quantity: parseInt(e.target.value, 10) || 0 })}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:bg-deep-charcoal/5"
            />
            <input
              data-testid={`volume-ladder-row-${idx}-max`}
              type="number"
              min={1}
              readOnly={readOnly}
              value={tier.max_quantity ?? ''}
              placeholder="∞"
              onChange={(e) => {
                const v = e.target.value.trim();
                updateRow(idx, { max_quantity: v === '' ? null : parseInt(v, 10) || 0 });
              }}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            <input
              data-testid={`volume-ladder-row-${idx}-amount`}
              type="number"
              min={0}
              readOnly={readOnly}
              value={tier.unit_amount_cents}
              onChange={(e) => updateRow(idx, { unit_amount_cents: parseInt(e.target.value, 10) || 0 })}
              className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {!readOnly && (
              <button
                type="button"
                data-testid={`volume-ladder-row-${idx}-remove`}
                onClick={() => removeRow(idx)}
                aria-label={`Remove tier ${idx + 1}`}
                className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                Remove
              </button>
            )}
          </div>
          {errors[idx] && (
            <span
              role="alert"
              data-testid={`volume-ladder-row-${idx}-error`}
              className="text-xs text-error-crimson"
            >
              {errors[idx]}
            </span>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          data-testid="volume-ladder-add"
          onClick={addRow}
          className="self-start rounded border border-primary-navy px-2 py-1 text-xs font-body text-primary-navy hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          + Add tier
        </button>
      )}
    </div>
  );
}

// ─── QuantityMeteredFields (HUB-1724) ──────────────────────────────────────

interface QuantityMeteredFieldsProps {
  readOnly: boolean;
  dimension: string | null;
  firstNFree: number;
  onChange: (patch: { dimension: string | null; firstNFree: number }) => void;
}

/**
 * Returns a cross-field error string if the state is inconsistent, else null.
 * The invariant: first_n_free > 0 requires a dimension to be set.
 */
export function validateQuantityMetered(
  dimension: string | null,
  firstNFree: number,
): string | null {
  if (firstNFree < 0) return 'First-N-free quantity cannot be negative.';
  if (firstNFree > 0 && !dimension) {
    return 'Setting first-N-free requires selecting a metered dimension first.';
  }
  return null;
}

export function QuantityMeteredFields({
  readOnly,
  dimension,
  firstNFree,
  onChange,
}: QuantityMeteredFieldsProps): React.ReactElement {
  const error = validateQuantityMetered(dimension, firstNFree);
  return (
    <div className="flex flex-col gap-2 rounded border border-deep-charcoal/15 p-3">
      <span className="text-sm font-body text-deep-charcoal/80">Quantity metering</span>
      <label className="flex flex-col gap-1 text-xs font-body text-deep-charcoal/70">
        Metered dimension
        <select
          data-testid="quantity-metered-dimension"
          disabled={readOnly}
          value={dimension ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? null : e.target.value;
            // Clear first-N-free when dimension is cleared, per S11 AC 2.
            onChange({ dimension: v, firstNFree: v === null ? 0 : firstNFree });
          }}
          className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:bg-deep-charcoal/5"
        >
          <option value="">— None —</option>
          {QUANTITY_METERED_DIMENSIONS.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <span className="text-xs text-deep-charcoal/50">
          e.g. LaunchKit per-app plans meter <code>environment</code> — first environment
          is included, additional environments are metered at the unit rate.
        </span>
      </label>
      {dimension !== null && (
        <label className="flex flex-col gap-1 text-xs font-body text-deep-charcoal/70">
          First N free (included with the license)
          <input
            data-testid="quantity-first-n-free"
            type="number"
            min={0}
            readOnly={readOnly}
            value={firstNFree}
            onChange={(e) => onChange({ dimension, firstNFree: parseInt(e.target.value, 10) || 0 })}
            className="rounded border border-deep-charcoal/20 p-1.5 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:bg-deep-charcoal/5"
          />
        </label>
      )}
      {error && (
        <span
          role="alert"
          data-testid="quantity-metered-error"
          className="text-xs text-error-crimson"
        >
          {error}
        </span>
      )}
    </div>
  );
}
