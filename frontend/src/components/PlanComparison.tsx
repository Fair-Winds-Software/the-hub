// Authorized by HUB-1637 (E-FE-4 S1) — PlanComparison reusable component.
// Cross-Epic primitive consumed by HUB-1640 (advisor result view) and the
// downstream HUB-1563 (pricing model editor) / HUB-1565 (scenario A/B
// comparison) surfaces. Renders a "before vs after" pairing of PlanData with
// delta indicators on the diffing fields plus an optional reasoning bullet
// list below the cards.
//
// Delta rules:
//   - price: numeric diff (signed); positive delta is rendered green
//     ("increased by $X"), negative red ("decreased by $X"). Caller controls
//     whether an increase is "good" or "bad" by reading the +/- sign.
//   - billingMode: string equality; differing values get a neutral highlight.
//   - features: set diff — added features highlighted on the right, removed
//     features highlighted on the left.
//
// A11y per spec: cards are <section aria-labelledby>, delta indicators carry
// a descriptive aria-label ("Price changed from $99 to $149, increased by
// $50"), reasoning is a numbered <ol> reachable in the Tab cycle.
import { useId, useMemo } from 'react';

export interface PlanData {
  title: string;
  /** Monthly price in dollars (whole number); null/undefined = unknown. */
  price?: number | null;
  /** e.g. "standard" / "credit" / "tiered" — string equality for delta. */
  billingMode?: string;
  features?: string[];
  metadata?: Record<string, unknown>;
}

export interface PlanComparisonProps {
  left?: PlanData | null;
  right?: PlanData | null;
  leftLabel?: string;
  rightLabel?: string;
  /** Default true. */
  highlightDeltas?: boolean;
  reasoningBullets?: string[];
  loading?: boolean;
}

interface DeltaIndicatorProps {
  fieldLabel: string;
  beforeText: string;
  afterText: string;
  /** Whole-dollar numeric delta when comparable; undefined for text-only. */
  numericDelta?: number;
}

function DeltaIndicator({
  fieldLabel,
  beforeText,
  afterText,
  numericDelta,
}: DeltaIndicatorProps): React.ReactElement {
  const direction =
    numericDelta === undefined
      ? 'changed'
      : numericDelta > 0
        ? 'increased'
        : numericDelta < 0
          ? 'decreased'
          : 'changed';
  const ariaLabel =
    numericDelta !== undefined && numericDelta !== 0
      ? `${fieldLabel} changed from ${beforeText} to ${afterText}, ${direction} by ${formatDollars(Math.abs(numericDelta))}`
      : `${fieldLabel} changed from ${beforeText} to ${afterText}`;
  const color =
    numericDelta === undefined
      ? 'text-deep-charcoal/80'
      : numericDelta > 0
        ? 'text-seafoam'
        : numericDelta < 0
          ? 'text-ironwake'
          : 'text-deep-charcoal/80';
  const arrow =
    numericDelta === undefined
      ? '→'
      : numericDelta > 0
        ? '↑'
        : numericDelta < 0
          ? '↓'
          : '→';
  return (
    <span
      data-testid={`plan-delta-${fieldLabel.toLowerCase().replace(/\s+/g, '-')}`}
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 text-xs font-body ${color}`}
    >
      <span aria-hidden="true">{arrow}</span>
      <span>
        {numericDelta !== undefined && numericDelta !== 0
          ? `${numericDelta > 0 ? '+' : '−'}${formatDollars(Math.abs(numericDelta))}`
          : 'changed'}
      </span>
    </span>
  );
}

function formatDollars(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

interface PlanCardProps {
  plan: PlanData | null | undefined;
  label: string;
  side: 'left' | 'right';
  diffs: Diffs | null;
  highlightDeltas: boolean;
}

interface Diffs {
  priceDelta: number | null;
  billingModeChanged: boolean;
  addedFeatures: Set<string>;
  removedFeatures: Set<string>;
}

function computeDiffs(left: PlanData | null | undefined, right: PlanData | null | undefined): Diffs | null {
  if (!left || !right) return null;
  const priceDelta =
    typeof left.price === 'number' && typeof right.price === 'number'
      ? right.price - left.price
      : null;
  const billingModeChanged =
    typeof left.billingMode === 'string' &&
    typeof right.billingMode === 'string' &&
    left.billingMode !== right.billingMode;
  const leftFeatures = new Set(left.features ?? []);
  const rightFeatures = new Set(right.features ?? []);
  const addedFeatures = new Set([...rightFeatures].filter((f) => !leftFeatures.has(f)));
  const removedFeatures = new Set([...leftFeatures].filter((f) => !rightFeatures.has(f)));
  return { priceDelta, billingModeChanged, addedFeatures, removedFeatures };
}

function PlanCard({
  plan,
  label,
  side,
  diffs,
  highlightDeltas,
}: PlanCardProps): React.ReactElement {
  const headingId = useId();
  if (!plan) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid={`plan-card-${side}`}
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
      >
        <h3
          id={headingId}
          className="font-heading text-base text-primary-navy mb-1"
        >
          {label}
        </h3>
        <p
          data-testid={`plan-card-${side}-empty`}
          className="font-body text-sm text-deep-charcoal/70"
        >
          No current plan assigned.
        </p>
      </section>
    );
  }

  const showPriceDelta =
    highlightDeltas &&
    diffs !== null &&
    diffs.priceDelta !== null &&
    diffs.priceDelta !== 0 &&
    side === 'right';
  const showBillingModeHighlight =
    highlightDeltas && diffs !== null && diffs.billingModeChanged;

  return (
    <section
      aria-labelledby={headingId}
      data-testid={`plan-card-${side}`}
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <header className="flex items-baseline justify-between gap-2 mb-2">
        <h3
          id={headingId}
          className="font-heading text-base text-primary-navy"
        >
          {label}
        </h3>
        <span
          data-testid={`plan-card-${side}-title`}
          className="font-body text-sm text-deep-charcoal"
        >
          {plan.title}
        </span>
      </header>
      <div className="flex flex-col gap-1.5">
        {typeof plan.price === 'number' && (
          <div className="grid grid-cols-[80px_1fr_auto] items-baseline gap-2">
            <span className="font-body text-xs text-deep-charcoal/70">Price</span>
            <span
              data-testid={`plan-card-${side}-price`}
              className={`font-body text-sm ${
                showPriceDelta ? 'font-medium text-primary-navy' : 'text-deep-charcoal'
              }`}
            >
              {formatDollars(plan.price)}/mo
            </span>
            {showPriceDelta && (
              <DeltaIndicator
                fieldLabel="Price"
                beforeText={`${formatDollars(plan.price - diffs!.priceDelta!)}/mo`}
                afterText={`${formatDollars(plan.price)}/mo`}
                numericDelta={diffs!.priceDelta!}
              />
            )}
          </div>
        )}
        {typeof plan.billingMode === 'string' && (
          <div className="grid grid-cols-[80px_1fr] items-baseline gap-2">
            <span className="font-body text-xs text-deep-charcoal/70">
              Billing
            </span>
            <span
              data-testid={`plan-card-${side}-billing`}
              className={`font-body text-sm ${
                showBillingModeHighlight
                  ? 'rounded bg-accent-brass/10 px-1 text-accent-brass'
                  : 'text-deep-charcoal'
              }`}
            >
              {plan.billingMode}
            </span>
          </div>
        )}
        {plan.features && plan.features.length > 0 && (
          <div className="grid grid-cols-[80px_1fr] items-start gap-2">
            <span className="font-body text-xs text-deep-charcoal/70 mt-0.5">
              Features
            </span>
            <ul
              data-testid={`plan-card-${side}-features`}
              className="flex flex-col gap-0.5"
            >
              {plan.features.map((f) => {
                const added = highlightDeltas && diffs?.addedFeatures.has(f);
                const removed =
                  highlightDeltas && diffs?.removedFeatures.has(f);
                const cls = added
                  ? 'rounded bg-seafoam/15 px-1 text-seafoam'
                  : removed
                    ? 'rounded bg-ironwake/10 px-1 text-ironwake line-through'
                    : 'text-deep-charcoal';
                const testIdSuffix = added
                  ? 'added'
                  : removed
                    ? 'removed'
                    : 'same';
                return (
                  <li
                    key={f}
                    data-testid={`plan-card-${side}-feature-${testIdSuffix}`}
                    className={`font-body text-xs ${cls}`}
                  >
                    {f}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function PlanComparisonSkeleton(): React.ReactElement {
  return (
    <div
      data-testid="plan-comparison-skeleton"
      className="grid grid-cols-1 gap-4 lg:grid-cols-2"
    >
      {[0, 1].map((i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-md bg-deep-charcoal/10"
        />
      ))}
    </div>
  );
}

export function PlanComparison({
  left,
  right,
  leftLabel = 'Current',
  rightLabel = 'Recommended',
  highlightDeltas = true,
  reasoningBullets,
  loading = false,
}: PlanComparisonProps): React.ReactElement {
  const diffs = useMemo(() => computeDiffs(left, right), [left, right]);

  if (loading) return <PlanComparisonSkeleton />;

  return (
    <div data-testid="plan-comparison" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PlanCard
          plan={left}
          label={leftLabel}
          side="left"
          diffs={diffs}
          highlightDeltas={highlightDeltas}
        />
        <PlanCard
          plan={right}
          label={rightLabel}
          side="right"
          diffs={diffs}
          highlightDeltas={highlightDeltas}
        />
      </div>
      {reasoningBullets && reasoningBullets.length > 0 && (
        <section
          aria-labelledby="plan-comparison-reasoning-heading"
          data-testid="plan-comparison-reasoning"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
        >
          <h3
            id="plan-comparison-reasoning-heading"
            className="font-heading text-base text-primary-navy mb-2"
          >
            Reasoning
          </h3>
          {/* AC#7 explicitly requires the reasoning list be keyboard-
              navigable. Without tabIndex=0 each <li> isn't focusable, so
              SR users can't tab through individual reasons. We suppress
              jsx-a11y/no-noninteractive-tabindex on each <li> for that
              reason. */}
          <ol className="flex flex-col gap-1.5 list-decimal pl-5">
            {reasoningBullets.map((b, i) => (
              <li
                key={i}
                data-testid={`reasoning-bullet-${i}`}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                className="font-body text-sm text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-accent-brass rounded"
              >
                {b}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

