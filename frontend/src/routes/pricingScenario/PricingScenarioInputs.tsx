// Authorized by HUB-1670 (E-FE-11 S2) — calculator input controls.
// Two paired slider + numeric inputs (price change % and churn assumption
// %). Debounced onChange (300ms) is delegated to the parent — this
// component is a controlled surface only.
//
// Slider ranges (per FR-003): price change -50 to +50, churn 0 to 30.
// The BE contract (HUB-1598) allows a wider window (price -100..1000,
// churn 0..100) but v0.1 UI clamps to the operator-realistic band.
import { useId } from 'react';

const PRICE_CHANGE_MIN = -50;
const PRICE_CHANGE_MAX = 50;
const CHURN_MIN = 0;
const CHURN_MAX = 30;

export interface PricingScenarioInputsProps {
  priceChangePercent: number;
  churnAssumptionPercent: number;
  onChange: (next: {
    priceChangePercent: number;
    churnAssumptionPercent: number;
  }) => void;
  disabled?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function PricingScenarioInputs({
  priceChangePercent,
  churnAssumptionPercent,
  onChange,
  disabled = false,
}: PricingScenarioInputsProps): React.ReactElement {
  const priceInputId = useId();
  const churnInputId = useId();

  return (
    <div className="flex flex-col gap-4 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={priceInputId}
            className="text-sm font-body text-deep-charcoal"
          >
            Price change %
          </label>
          <span
            data-testid="pricing-scenario-price-value"
            className="rounded border border-deep-charcoal/15 bg-white px-2 py-0.5 text-xs font-mono text-deep-charcoal"
          >
            {priceChangePercent > 0 ? '+' : ''}
            {priceChangePercent}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            id={priceInputId}
            data-testid="pricing-scenario-price-slider"
            type="range"
            min={PRICE_CHANGE_MIN}
            max={PRICE_CHANGE_MAX}
            step={1}
            value={priceChangePercent}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                priceChangePercent: clamp(
                  parseInt(e.target.value, 10),
                  PRICE_CHANGE_MIN,
                  PRICE_CHANGE_MAX,
                ),
                churnAssumptionPercent,
              })
            }
            className="flex-1 accent-primary-navy"
            aria-valuemin={PRICE_CHANGE_MIN}
            aria-valuemax={PRICE_CHANGE_MAX}
            aria-valuenow={priceChangePercent}
          />
          <input
            data-testid="pricing-scenario-price-number"
            type="number"
            min={PRICE_CHANGE_MIN}
            max={PRICE_CHANGE_MAX}
            step={1}
            value={priceChangePercent}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                priceChangePercent: clamp(
                  parseFloat(e.target.value),
                  PRICE_CHANGE_MIN,
                  PRICE_CHANGE_MAX,
                ),
                churnAssumptionPercent,
              })
            }
            aria-label="Price change percent (numeric input)"
            className="w-16 rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={churnInputId}
            className="text-sm font-body text-deep-charcoal"
            title="Higher churn = more customers leave = lower MRR"
          >
            Churn assumption %
          </label>
          <span
            data-testid="pricing-scenario-churn-value"
            className="rounded border border-deep-charcoal/15 bg-white px-2 py-0.5 text-xs font-mono text-deep-charcoal"
          >
            {churnAssumptionPercent}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            id={churnInputId}
            data-testid="pricing-scenario-churn-slider"
            type="range"
            min={CHURN_MIN}
            max={CHURN_MAX}
            step={1}
            value={churnAssumptionPercent}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                priceChangePercent,
                churnAssumptionPercent: clamp(
                  parseInt(e.target.value, 10),
                  CHURN_MIN,
                  CHURN_MAX,
                ),
              })
            }
            className="flex-1 accent-primary-navy"
            aria-valuemin={CHURN_MIN}
            aria-valuemax={CHURN_MAX}
            aria-valuenow={churnAssumptionPercent}
          />
          <input
            data-testid="pricing-scenario-churn-number"
            type="number"
            min={CHURN_MIN}
            max={CHURN_MAX}
            step={1}
            value={churnAssumptionPercent}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                priceChangePercent,
                churnAssumptionPercent: clamp(
                  parseFloat(e.target.value),
                  CHURN_MIN,
                  CHURN_MAX,
                ),
              })
            }
            aria-label="Churn assumption percent (numeric input)"
            className="w-16 rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
          />
        </div>
        <p className="text-xs font-body text-deep-charcoal/50">
          Higher churn = more customers leave = lower MRR.
        </p>
      </div>
    </div>
  );
}
