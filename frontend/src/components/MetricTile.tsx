// Authorized by HUB-1620 (E-FE-8 S1) — MetricTile reusable component. Cross-Epic
// primitive consumed by HUB-1622 (compliance grid) and the downstream HUB-1560
// (SDK versions) / HUB-1566 (system health) / HUB-1567 (customer health)
// portfolio surfaces. Each one needs a header + big number + verdict indicator
// + optional drift badge — that lives once, here.
//
// WCAG AA: verdict is COLOR + ICON + TEXT LABEL. Color alone is insufficient;
// the icon (success/warning/error/neutral glyph) and the text label both pair
// with the verdict so SR + colorblind operators get the same signal.
//
// Empty value renders "—" with aria-label="No data" so screen readers don't
// read out the em-dash as punctuation noise.
import type { KeyboardEvent, ReactNode } from 'react';
import { MetricInfoPopover, type MetricInfoContent } from './MetricInfoPopover';

export type MetricVerdict = 'success' | 'warning' | 'error' | 'neutral';
export type MetricDrift = 'up' | 'down' | 'flat';

export interface MetricTileProps {
  title: string;
  /** Numeric or pre-formatted string; null/undefined renders the "no data" em-dash. */
  value: number | string | null | undefined;
  /** Trailing unit suffix; rendered next to the value at a smaller size. */
  unit?: string;
  /** Triple-encoded verdict (color + icon + text label). Defaults to 'neutral'. */
  verdict?: MetricVerdict;
  /** Optional icon override; defaults to the verdict glyph. */
  icon?: ReactNode;
  /** Optional footer slot (e.g. "vs. last 7 days", small links). */
  footer?: ReactNode;
  /** When provided, the tile becomes role=button with keyboard activation. */
  onClick?: () => void;
  /** Drift badge in the top-right corner. */
  drift?: MetricDrift;
  /** Drift badge body text (e.g. "+5", "−10"). */
  driftLabel?: string;
  /** Renders the matching-dimension skeleton instead of content. */
  loading?: boolean;
  /**
   * Override the auto-generated aria-label. Default composes:
   * "{title}: {value} {unit}, {verdict label}".
   */
  ariaLabel?: string;
  /**
   * When provided, an Info icon appears next to the title. Clicking it opens a
   * popover with definition / formula / source / verdict legend so operators
   * can inspect what a metric actually measures.
   */
  info?: MetricInfoContent;
}

const VERDICT_LABELS: Record<MetricVerdict, string> = {
  success: 'healthy',
  warning: 'warning',
  error: 'error',
  neutral: 'neutral',
};

const VERDICT_COLOR_CLASSES: Record<MetricVerdict, string> = {
  success: 'border-seafoam/30 bg-seafoam/5',
  warning: 'border-accent-brass/40 bg-accent-brass/5',
  error: 'border-ironwake/40 bg-ironwake/5',
  neutral: 'border-deep-charcoal/15 bg-sailcloth',
};

const VERDICT_TEXT_CLASSES: Record<MetricVerdict, string> = {
  success: 'text-seafoam',
  warning: 'text-accent-brass',
  error: 'text-ironwake',
  neutral: 'text-deep-charcoal/70',
};

function VerdictGlyph({ verdict }: { verdict: MetricVerdict }): React.ReactElement {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    'aria-hidden': true as const,
  };
  switch (verdict) {
    case 'success':
      return (
        <svg {...common} data-testid="verdict-glyph-success">
          <path
            d="M3.5 8.5L6.5 11.5L12.5 5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common} data-testid="verdict-glyph-warning">
          <path
            d="M8 2L14 13H2L8 2Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
            fill="none"
          />
          <line
            x1="8"
            y1="6"
            x2="8"
            y2="9.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.5" r="0.8" fill="currentColor" />
        </svg>
      );
    case 'error':
      return (
        <svg {...common} data-testid="verdict-glyph-error">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" fill="none" />
          <line
            x1="5"
            y1="5"
            x2="11"
            y2="11"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <line
            x1="11"
            y1="5"
            x2="5"
            y2="11"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'neutral':
    default:
      return (
        <svg {...common} data-testid="verdict-glyph-neutral">
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </svg>
      );
  }
}

const DRIFT_LABEL: Record<MetricDrift, string> = {
  up: 'trending up',
  down: 'trending down',
  flat: 'flat',
};

const DRIFT_GLYPH: Record<MetricDrift, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

const DRIFT_CLASS: Record<MetricDrift, string> = {
  up: 'text-seafoam',
  down: 'text-ironwake',
  flat: 'text-deep-charcoal/60',
};

function DriftBadge({
  drift,
  label,
}: {
  drift: MetricDrift;
  label?: string;
}): React.ReactElement {
  return (
    <span
      data-testid={`drift-badge-${drift}`}
      aria-label={`${DRIFT_LABEL[drift]}${label ? `: ${label}` : ''}`}
      className={`inline-flex items-center gap-1 text-xs font-body ${DRIFT_CLASS[drift]}`}
    >
      <span aria-hidden="true">{DRIFT_GLYPH[drift]}</span>
      {label && <span>{label}</span>}
    </span>
  );
}

function isEmpty(value: MetricTileProps['value']): boolean {
  return value === null || value === undefined || value === '';
}

function composeAriaLabel({
  title,
  value,
  unit,
  verdict,
}: {
  title: string;
  value: MetricTileProps['value'];
  unit?: string;
  verdict: MetricVerdict;
}): string {
  if (isEmpty(value)) return `${title}: no data`;
  const unitSuffix = unit ? ` ${unit}` : '';
  return `${title}: ${value}${unitSuffix}, ${VERDICT_LABELS[verdict]}`;
}

export function MetricTile({
  title,
  value,
  unit,
  verdict = 'neutral',
  icon,
  footer,
  onClick,
  drift,
  driftLabel,
  loading = false,
  ariaLabel,
  info,
}: MetricTileProps): React.ReactElement {
  const clickable = !!onClick;

  if (loading) {
    return (
      <div
        data-testid="metric-tile-skeleton"
        className="flex h-[160px] w-full max-w-[240px] flex-col gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
        aria-busy="true"
      >
        <div className="h-3 w-1/2 animate-pulse rounded bg-deep-charcoal/10" />
        <div className="mt-2 h-8 w-3/4 animate-pulse rounded bg-deep-charcoal/10" />
        <div className="mt-auto h-3 w-1/3 animate-pulse rounded bg-deep-charcoal/10" />
      </div>
    );
  }

  const empty = isEmpty(value);
  const composedAria = ariaLabel ?? composeAriaLabel({ title, value, unit, verdict });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!clickable) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick!();
    }
  };

  return (
    <div
      data-testid="metric-tile"
      role={clickable ? 'button' : 'group'}
      tabIndex={clickable ? 0 : undefined}
      aria-label={composedAria}
      onClick={clickable ? onClick : undefined}
      onKeyDown={handleKeyDown}
      className={[
        'relative flex h-[160px] w-full max-w-[240px] flex-col gap-1 rounded-md border p-4 transition-colors',
        VERDICT_COLOR_CLASSES[verdict],
        clickable
          ? 'cursor-pointer hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass'
          : '',
      ].join(' ')}
    >
      {drift && (
        <div className="absolute right-3 top-3">
          <DriftBadge drift={drift} label={driftLabel} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className={VERDICT_TEXT_CLASSES[verdict]}>
          {icon ?? <VerdictGlyph verdict={verdict} />}
        </span>
        <h3
          data-testid="metric-tile-title"
          className="font-body text-sm text-deep-charcoal/80"
        >
          {title}
        </h3>
        {info && <MetricInfoPopover title={title} content={info} />}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        {empty ? (
          <span
            data-testid="metric-tile-empty-value"
            aria-label="No data"
            className="text-3xl text-deep-charcoal/40"
          >
            —
          </span>
        ) : (
          <>
            <span
              data-testid="metric-tile-value"
              className="font-heading text-3xl text-primary-navy"
            >
              {value}
            </span>
            {unit && (
              <span
                data-testid="metric-tile-unit"
                className="font-body text-sm text-deep-charcoal/60"
              >
                {unit}
              </span>
            )}
          </>
        )}
      </div>
      <span
        data-testid={`metric-tile-verdict-${verdict}`}
        className={`text-xs font-body ${VERDICT_TEXT_CLASSES[verdict]}`}
      >
        {VERDICT_LABELS[verdict]}
      </span>
      {footer && (
        <div
          data-testid="metric-tile-footer"
          className="mt-auto text-xs font-body text-deep-charcoal/60"
        >
          {footer}
        </div>
      )}
    </div>
  );
}
