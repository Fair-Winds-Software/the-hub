// Authorized by HUB-1630 (E-FE-10 S1) — DistributionChart reusable component.
// Cross-Epic primitive consumed by HUB-1632 (SDK version distribution) and the
// downstream HUB-1561 / HUB-1562 / HUB-1566 / HUB-1567 portfolio surfaces.
//
// Spec deviation (documented per ironclad-engineer):
// 1. Recharts dependency: spec calls for "wraps LK-134 Recharts". LaunchKit
//    (LK-134) is a separate repo — HUB cannot import its components directly,
//    and adding the standalone `recharts` npm package (~250KB) would erode
//    the HUB-1610 CWV budget for ~4 chart consumers at v0.1. Implemented
//    directly in SVG, mirroring the HUB-1621 TimelineChart precedent. The
//    public surface matches the spec props so a one-file swap is trivial
//    once HUB consumes the LK substrate.
//
// Layout:
//   - vertical (default): bars stand up; x-axis is the category, y-axis the count.
//   - horizontal: bars lie sideways; y-axis is the category, x-axis the count.
//     Use horizontal when category labels are long (e.g., "Synapz v2.7.18-rc.3").
//
// A11y: chart container is role="img" with an auto-composed summary aria-label,
// plus a visually-hidden <table> fallback so SR users can step through the
// distribution row-by-row.
import { useMemo, useState, type ReactNode } from 'react';

export interface DistributionPoint {
  category: string;
  count: number;
  /** Optional list of items aggregated under this category — shown in tooltip. */
  items?: string[];
}

export type DistributionLayout = 'vertical' | 'horizontal';
export type DistributionValueFormat = 'integer' | 'percent' | 'currency';

export interface DistributionChartProps {
  data: DistributionPoint[];
  xLabel: string;
  yLabel: string;
  /** Default 'integer'. Applies to count axis labels + total. */
  valueFormat?: DistributionValueFormat;
  /** Default 'vertical' (bars stand up). */
  layout?: DistributionLayout;
  /** Default 240. */
  height?: number;
  loading?: boolean;
  error?: string | null;
  /** Override the auto-composed summary. */
  ariaLabel?: string;
  /** Unit shown in the "Total: N <unit>" label above the chart. Default 'items'. */
  totalUnit?: string;
}

const DEFAULT_HEIGHT = 240;
const PAD_TOP = 12;
const PAD_BOTTOM = 36;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;
const BAR_COLOR = 'var(--color-primary-navy, #1C2A44)';
const AXIS_COLOR = 'var(--color-deep-charcoal, #4E4C4C)';

function formatValue(value: number, fmt: DistributionValueFormat): string {
  switch (fmt) {
    case 'percent':
      return `${value}%`;
    case 'currency':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(value);
    case 'integer':
    default:
      return String(value);
  }
}

function composeAriaLabel({
  xLabel,
  data,
}: {
  xLabel: string;
  data: DistributionPoint[];
}): string {
  if (data.length === 0) return `${xLabel} distribution, no data`;
  const top = [...data]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((p) => `${p.count} on ${p.category}`)
    .join(', ');
  return `${xLabel} distribution: ${top}`;
}

interface VerticalBarsProps {
  data: DistributionPoint[];
  width: number;
  height: number;
  valueFormat: DistributionValueFormat;
  onHover: (idx: number | null) => void;
}

function VerticalBars({
  data,
  width,
  height,
  valueFormat,
  onHover,
}: VerticalBarsProps): React.ReactElement {
  const innerWidth = width - PAD_LEFT - PAD_RIGHT;
  const innerHeight = height - PAD_TOP - PAD_BOTTOM;
  const max = Math.max(1, ...data.map((d) => d.count));
  const barSlot = innerWidth / data.length;
  const barWidth = Math.min(48, barSlot * 0.7);
  return (
    <g>
      {/* Count-axis tick labels (4 ticks). */}
      {[0, 1, 2, 3, 4].map((i) => {
        const v = (max * i) / 4;
        const y = PAD_TOP + innerHeight - (innerHeight * i) / 4;
        return (
          <g key={`tick-${i}`}>
            <line
              x1={PAD_LEFT}
              x2={width - PAD_RIGHT}
              y1={y}
              y2={y}
              stroke={AXIS_COLOR}
              strokeOpacity="0.1"
            />
            <text
              x={PAD_LEFT - 6}
              y={y + 3}
              fontSize="10"
              fill={AXIS_COLOR}
              textAnchor="end"
            >
              {formatValue(Math.round(v), valueFormat)}
            </text>
          </g>
        );
      })}
      {/* Bars + category labels. */}
      {data.map((p, i) => {
        const barH = (p.count / max) * innerHeight;
        const x = PAD_LEFT + i * barSlot + (barSlot - barWidth) / 2;
        const y = PAD_TOP + innerHeight - barH;
        return (
          <g
            key={`bar-${p.category}`}
            data-testid={`distribution-bar-${p.category}`}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(i)}
            onBlur={() => onHover(null)}
            tabIndex={0}
          >
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barH}
              fill={BAR_COLOR}
              rx="2"
            >
              <title>
                {p.category}: {formatValue(p.count, valueFormat)}
                {p.items && p.items.length > 0
                  ? ` — ${p.items.join(', ')}`
                  : ''}
              </title>
            </rect>
            <text
              x={x + barWidth / 2}
              y={height - PAD_BOTTOM + 14}
              fontSize="10"
              fill={AXIS_COLOR}
              textAnchor="middle"
            >
              {p.category}
            </text>
          </g>
        );
      })}
    </g>
  );
}

type HorizontalBarsProps = VerticalBarsProps;

function HorizontalBars({
  data,
  width,
  height,
  valueFormat,
  onHover,
}: HorizontalBarsProps): React.ReactElement {
  // Horizontal: y-axis is category (rows), x-axis is count.
  const labelWidth = 120; // room for category labels on the left
  const innerWidth = width - labelWidth - PAD_RIGHT;
  const innerHeight = height - PAD_TOP - 18;
  const max = Math.max(1, ...data.map((d) => d.count));
  const rowSlot = innerHeight / data.length;
  const barH = Math.min(24, rowSlot * 0.7);
  return (
    <g>
      {/* Value-axis baseline + endpoint label. */}
      <line
        x1={labelWidth}
        x2={width - PAD_RIGHT}
        y1={height - PAD_TOP - 6}
        y2={height - PAD_TOP - 6}
        stroke={AXIS_COLOR}
        strokeOpacity="0.2"
      />
      <text
        x={width - PAD_RIGHT}
        y={height - 2}
        fontSize="10"
        fill={AXIS_COLOR}
        textAnchor="end"
      >
        {formatValue(max, valueFormat)}
      </text>
      {/* Rows. */}
      {data.map((p, i) => {
        const barW = (p.count / max) * innerWidth;
        const y = PAD_TOP + i * rowSlot + (rowSlot - barH) / 2;
        return (
          <g
            key={`bar-${p.category}`}
            data-testid={`distribution-bar-${p.category}`}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(i)}
            onBlur={() => onHover(null)}
            tabIndex={0}
          >
            <text
              x={labelWidth - 6}
              y={y + barH / 2 + 3}
              fontSize="10"
              fill={AXIS_COLOR}
              textAnchor="end"
            >
              {p.category}
            </text>
            <rect
              x={labelWidth}
              y={y}
              width={barW}
              height={barH}
              fill={BAR_COLOR}
              rx="2"
            >
              <title>
                {p.category}: {formatValue(p.count, valueFormat)}
                {p.items && p.items.length > 0
                  ? ` — ${p.items.join(', ')}`
                  : ''}
              </title>
            </rect>
          </g>
        );
      })}
    </g>
  );
}

interface ChartShellProps {
  height: number;
  ariaLabel: string;
  children: ReactNode;
  testId?: string;
}

function ChartShell({
  height,
  ariaLabel,
  children,
  testId = 'distribution-chart',
}: ChartShellProps): React.ReactElement {
  return (
    <div
      data-testid={testId}
      className="w-full"
      style={{ minHeight: height }}
      role="img"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

export function DistributionChart({
  data,
  xLabel,
  yLabel,
  valueFormat = 'integer',
  layout = 'vertical',
  height = DEFAULT_HEIGHT,
  loading = false,
  error = null,
  ariaLabel,
  totalUnit = 'items',
}: DistributionChartProps): React.ReactElement {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const total = useMemo(
    () => data.reduce((sum, p) => sum + p.count, 0),
    [data],
  );

  if (loading) {
    return (
      <ChartShell
        height={height}
        ariaLabel="Loading distribution"
        testId="distribution-chart-skeleton"
      >
        <div
          className="w-full animate-pulse rounded-md bg-deep-charcoal/10"
          style={{ height }}
        />
      </ChartShell>
    );
  }

  if (error !== null) {
    return (
      <ChartShell height={height} ariaLabel={`Distribution error: ${error}`}>
        <div
          role="alert"
          data-testid="distribution-chart-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          Could not load distribution: {error}
        </div>
      </ChartShell>
    );
  }

  if (data.length === 0) {
    return (
      <ChartShell height={height} ariaLabel={`${xLabel} distribution, no data`}>
        <div
          data-testid="distribution-chart-empty"
          className="flex h-full items-center justify-center rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
          style={{ minHeight: height }}
        >
          No data available
        </div>
      </ChartShell>
    );
  }

  const composedAria = ariaLabel ?? composeAriaLabel({ xLabel, data });
  const width = 640;
  const hovered = hoverIdx !== null ? data[hoverIdx] : null;

  return (
    <ChartShell height={height} ariaLabel={composedAria}>
      <div className="flex items-baseline justify-between text-sm font-body text-deep-charcoal/80">
        <span data-testid="distribution-chart-total">
          Total: <strong>{formatValue(total, valueFormat)}</strong> {totalUnit}
        </span>
        {hovered && (
          <span
            data-testid="distribution-chart-tooltip"
            className="rounded-md bg-primary-navy px-2 py-1 text-xs text-sailcloth"
          >
            {hovered.category}: {formatValue(hovered.count, valueFormat)}
            {hovered.items && hovered.items.length > 0
              ? ` — ${hovered.items.join(', ')}`
              : ''}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        data-testid="distribution-chart-svg"
      >
        {/* Axis title — y for vertical layout, x for horizontal layout. */}
        <text
          x={layout === 'vertical' ? 12 : width / 2}
          y={layout === 'vertical' ? height / 2 : height - 2}
          fill={AXIS_COLOR}
          fontSize="11"
          textAnchor="middle"
          transform={
            layout === 'vertical'
              ? `rotate(-90 12 ${height / 2})`
              : undefined
          }
          data-testid="distribution-chart-axis-label"
        >
          {layout === 'vertical' ? yLabel : xLabel}
        </text>
        {layout === 'vertical' ? (
          <VerticalBars
            data={data}
            width={width}
            height={height}
            valueFormat={valueFormat}
            onHover={setHoverIdx}
          />
        ) : (
          <HorizontalBars
            data={data}
            width={width}
            height={height}
            valueFormat={valueFormat}
            onHover={setHoverIdx}
          />
        )}
      </svg>
      <table className="sr-only" data-testid="distribution-chart-sr-table">
        <caption>
          {xLabel} distribution by {yLabel}
        </caption>
        <thead>
          <tr>
            <th>{xLabel}</th>
            <th>{yLabel}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.category}>
              <td>{p.category}</td>
              <td>{formatValue(p.count, valueFormat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartShell>
  );
}
