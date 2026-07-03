// Authorized by HUB-1682 (E-FE-9 S3) — Customer Health filter sidebar +
// CSV export button. Three controls: product dropdown, risk-level multi-
// select checkboxes, MRR range (min/max numeric inputs — dual-slider
// deferred for v0.2 since it needs a headless-ui-quality component and
// numeric inputs give operators more precision at v0.1).
//
// The parent (CustomerHealth) owns URL state via useSearchParams; this
// component is a pure controlled surface — no local state beyond the
// slider-debounce timer for MRR.
import { useEffect, useRef, useState } from 'react';
import { formatCurrency } from './customer-health-formatters';

const MRR_DEBOUNCE_MS = 300;
const RISK_LEVELS = ['high', 'medium', 'low'] as const;
type RiskLevel = (typeof RISK_LEVELS)[number];

export interface CustomerHealthFilterValue {
  productId: string | null;
  riskLevels: RiskLevel[];
  mrrMin: number | null;
  mrrMax: number | null;
}

export interface CustomerHealthProduct {
  productId: string;
  productName: string;
}

interface CustomerHealthFiltersProps {
  value: CustomerHealthFilterValue;
  onChange: (next: CustomerHealthFilterValue) => void;
  onReset: () => void;
  onExportCsv: () => void;
  products: CustomerHealthProduct[];
  exportDisabled: boolean;
}

export function CustomerHealthFilters({
  value,
  onChange,
  onReset,
  onExportCsv,
  products,
  exportDisabled,
}: CustomerHealthFiltersProps): React.ReactElement {
  const [mrrMinInput, setMrrMinInput] = useState(
    value.mrrMin != null ? String(value.mrrMin / 100) : '',
  );
  const [mrrMaxInput, setMrrMaxInput] = useState(
    value.mrrMax != null ? String(value.mrrMax / 100) : '',
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local inputs in sync when URL state changes externally (e.g. Reset).
  useEffect(() => {
    setMrrMinInput(value.mrrMin != null ? String(value.mrrMin / 100) : '');
    setMrrMaxInput(value.mrrMax != null ? String(value.mrrMax / 100) : '');
  }, [value.mrrMin, value.mrrMax]);

  const commitMrr = (minDollars: string, maxDollars: string): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const min = minDollars === '' ? null : Math.round(parseFloat(minDollars) * 100);
      const max = maxDollars === '' ? null : Math.round(parseFloat(maxDollars) * 100);
      onChange({
        ...value,
        mrrMin: Number.isFinite(min) ? (min as number | null) : null,
        mrrMax: Number.isFinite(max) ? (max as number | null) : null,
      });
    }, MRR_DEBOUNCE_MS);
  };

  const toggleRisk = (level: RiskLevel): void => {
    const next = value.riskLevels.includes(level)
      ? value.riskLevels.filter((l) => l !== level)
      : [...value.riskLevels, level];
    onChange({ ...value, riskLevels: next });
  };

  return (
    <aside
      data-testid="customer-health-filters"
      className="flex w-full flex-col gap-4 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 md:w-60"
      aria-label="Filter Customer Health"
    >
      <div className="flex flex-col gap-2">
        <button
          type="button"
          data-testid="customer-health-export"
          onClick={onExportCsv}
          disabled={exportDisabled}
          className="rounded border border-primary-navy/40 bg-primary-navy px-3 py-1 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Export CSV
        </button>
        <button
          type="button"
          data-testid="customer-health-reset"
          onClick={onReset}
          className="rounded border border-deep-charcoal/20 bg-transparent px-3 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Reset filters
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="customer-health-filter-product"
          className="text-xs font-body text-deep-charcoal/70"
        >
          Product
        </label>
        <select
          id="customer-health-filter-product"
          data-testid="customer-health-filter-product"
          value={value.productId ?? ''}
          onChange={(e) =>
            onChange({ ...value, productId: e.target.value || null })
          }
          className="rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          <option value="">All products</option>
          {products.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.productName}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-body text-deep-charcoal/70">
          Risk level
        </legend>
        {RISK_LEVELS.map((level) => {
          const label =
            level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low';
          const checked = value.riskLevels.includes(level);
          return (
            <label
              key={level}
              className="inline-flex items-center gap-2 text-sm font-body text-deep-charcoal"
            >
              <input
                type="checkbox"
                data-testid={`customer-health-filter-risk-${level}`}
                checked={checked}
                onChange={() => toggleRisk(level)}
                className="rounded focus:ring-2 focus:ring-accent-brass"
              />
              {label}
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-body text-deep-charcoal/70">MRR range</span>
        <div className="flex items-center gap-2">
          <label
            htmlFor="customer-health-filter-mrr-min"
            className="sr-only"
          >
            Minimum MRR
          </label>
          <input
            id="customer-health-filter-mrr-min"
            data-testid="customer-health-filter-mrr-min"
            type="number"
            inputMode="numeric"
            placeholder="Min $"
            value={mrrMinInput}
            onChange={(e) => {
              setMrrMinInput(e.target.value);
              commitMrr(e.target.value, mrrMaxInput);
            }}
            className="w-full rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
          />
          <span aria-hidden="true" className="text-xs text-deep-charcoal/60">
            –
          </span>
          <label
            htmlFor="customer-health-filter-mrr-max"
            className="sr-only"
          >
            Maximum MRR
          </label>
          <input
            id="customer-health-filter-mrr-max"
            data-testid="customer-health-filter-mrr-max"
            type="number"
            inputMode="numeric"
            placeholder="Max $"
            value={mrrMaxInput}
            onChange={(e) => {
              setMrrMaxInput(e.target.value);
              commitMrr(mrrMinInput, e.target.value);
            }}
            className="w-full rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
          />
        </div>
        {(value.mrrMin != null || value.mrrMax != null) && (
          <p className="text-xs font-body text-deep-charcoal/50">
            {formatCurrency(value.mrrMin ?? 0)} –{' '}
            {value.mrrMax != null ? formatCurrency(value.mrrMax) : 'no cap'}
          </p>
        )}
      </div>
    </aside>
  );
}
