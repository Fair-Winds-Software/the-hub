// Authorized by HUB-1766 (E-V2-PP-5 S7, HUB-1729, HUB-1701) — Quota Sub-Unlock
// editor for quarterly plans. Composable module intended for use in the Plans
// New/Edit modal in PlansManager.tsx; ships as a self-contained component with
// its own validator so downstream consumers can render + submit independently.

import { useState } from 'react';

export interface QuotaSubUnlockRow {
  dimension_key: string;
  per_month_quantity: number;
}

export interface QuotaSubUnlockDraft {
  dimension_key: string;
  per_month_quantity: string;
}

export interface QuotaSubUnlockErrors {
  [rowIndex: string]: { dimension_key?: string; per_month_quantity?: string };
}

const KEY_RE = /^[a-z][a-z0-9_]{2,63}$/;

export function validateQuotaSubUnlocks(rows: QuotaSubUnlockDraft[]): QuotaSubUnlockErrors {
  const errors: QuotaSubUnlockErrors = {};
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const rowErr: { dimension_key?: string; per_month_quantity?: string } = {};
    if (!r.dimension_key.trim()) {
      rowErr.dimension_key = 'required';
    } else if (!KEY_RE.test(r.dimension_key)) {
      rowErr.dimension_key = 'snake_case, 3–64 chars';
    } else if (seen.has(r.dimension_key)) {
      rowErr.dimension_key = 'duplicate';
    } else {
      seen.add(r.dimension_key);
    }
    const n = parseInt(r.per_month_quantity, 10);
    if (!r.per_month_quantity || Number.isNaN(n) || n < 1) {
      rowErr.per_month_quantity = 'must be >= 1';
    }
    if (rowErr.dimension_key || rowErr.per_month_quantity) errors[String(i)] = rowErr;
  });
  return errors;
}

export function draftToSubmit(rows: QuotaSubUnlockDraft[]): QuotaSubUnlockRow[] {
  return rows.map((r) => ({
    dimension_key: r.dimension_key.trim(),
    per_month_quantity: parseInt(r.per_month_quantity, 10),
  }));
}

interface Props {
  initial?: QuotaSubUnlockRow[];
  onChange: (rows: QuotaSubUnlockDraft[]) => void;
  disabled?: boolean;
}

export function QuotaSubUnlockEditor({ initial, onChange, disabled }: Props): React.ReactElement {
  const [rows, setRows] = useState<QuotaSubUnlockDraft[]>(() =>
    (initial ?? []).map((r) => ({
      dimension_key: r.dimension_key,
      per_month_quantity: String(r.per_month_quantity),
    })),
  );
  const errors = validateQuotaSubUnlocks(rows);

  function update(next: QuotaSubUnlockDraft[]): void {
    setRows(next);
    onChange(next);
  }

  return (
    <div data-testid="quota-sub-unlock-editor" className="flex flex-col gap-2 rounded border border-deep-charcoal/15 p-3">
      <div className="text-sm font-semibold text-primary-navy">Monthly Quota Sub-Unlocks</div>
      <p className="text-xs text-deep-charcoal/70">
        For quarterly plans, entitlement unlocks month-by-month within each 3-month cycle.
      </p>
      {rows.length === 0 && (
        <p data-testid="quota-sub-unlock-empty" className="text-xs text-deep-charcoal/60 italic">
          No sub-unlocks configured yet.
        </p>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-2" data-testid={`quota-sub-unlock-row-${i}`}>
          <label className="flex flex-1 flex-col gap-1 text-xs text-deep-charcoal/80">
            Dimension key
            <input
              data-testid={`quota-sub-unlock-key-${i}`}
              type="text"
              value={r.dimension_key}
              disabled={disabled}
              onChange={(e) => {
                const next = rows.slice();
                next[i] = { ...next[i]!, dimension_key: e.target.value };
                update(next);
              }}
              aria-invalid={errors[String(i)]?.dimension_key ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy"
            />
            {errors[String(i)]?.dimension_key && (
              <span data-testid={`quota-sub-unlock-key-err-${i}`} className="text-xs text-ironwake">
                {errors[String(i)]!.dimension_key}
              </span>
            )}
          </label>
          <label className="flex w-32 flex-col gap-1 text-xs text-deep-charcoal/80">
            Per month
            <input
              data-testid={`quota-sub-unlock-qty-${i}`}
              type="number"
              min={1}
              value={r.per_month_quantity}
              disabled={disabled}
              onChange={(e) => {
                const next = rows.slice();
                next[i] = { ...next[i]!, per_month_quantity: e.target.value };
                update(next);
              }}
              aria-invalid={errors[String(i)]?.per_month_quantity ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy"
            />
            {errors[String(i)]?.per_month_quantity && (
              <span data-testid={`quota-sub-unlock-qty-err-${i}`} className="text-xs text-ironwake">
                {errors[String(i)]!.per_month_quantity}
              </span>
            )}
          </label>
          <button
            type="button"
            data-testid={`quota-sub-unlock-remove-${i}`}
            disabled={disabled}
            onClick={() => update(rows.filter((_, j) => j !== i))}
            className="mt-5 rounded border border-deep-charcoal/20 p-2 text-xs text-ironwake hover:bg-ironwake/5"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        data-testid="quota-sub-unlock-add"
        disabled={disabled}
        onClick={() => update([...rows, { dimension_key: '', per_month_quantity: '' }])}
        className="self-start rounded border border-deep-charcoal/20 px-3 py-1 text-xs text-primary-navy hover:bg-primary-navy/5"
      >
        + Add sub-unlock
      </button>
    </div>
  );
}
