// Authorized by HUB-1621 (E-FE-8 S2) — TimelineChart reusable component. Cross-
// Epic primitive consumed by HUB-1624 (verdict history) and downstream HUB-1566
// (system health) / HUB-1567 (customer health).
//
// Spec deviation (documented per ironclad-engineer):
// 1. Recharts dependency: spec calls for "wraps LK-134 Recharts". LaunchKit
//    (LK-134) is a separate repo (Fair-Winds-Software/launchkit) — HUB cannot
//    import its components directly, and adding the standalone `recharts` npm
//    package (~250KB) would erode the HUB-1610 CWV budget for ~3 chart
//    consumers at v0.1. Implemented directly in SVG (~200 LOC) instead. The
//    public surface matches the spec props so a one-file swap to recharts is
//    trivial once HUB consumes the LK substrate.
//
// Accessibility contract: chart container is role="img" with an aria-label that
// summarizes the trend (per WCAG 1.4.5 — meaningful image label). A visually-
// hidden <table> renders the same data so screen readers can step through point-
// by-point — the canonical "complex image + data table fallback" pattern.
import { useMemo, type ReactNode } from 'react';

export type AnnotationSeverity = 'info' | 'warning' | 'error';

export interface TimelinePoint {
  /** ISO date string (yyyy-mm-dd). */
  date: string;
  value: number;
}

export interface TimelineAnnotation {
  /** ISO date string — must match the granularity of `data` points. */
  date: string;
  label: string;
  severity?: AnnotationSeverity;
}

export type ValueFormat = 'integer' | 'percent' | 'currency';

export interface TimelineChartProps {
  data: TimelinePoint[];
  yLabel: string;
  /** Default 'integer'. */
  valueFormat?: ValueFormat;
  annotations?: TimelineAnnotation[];
  /** Default 200px. */
  height?: number;
  loading?: boolean;
  error?: string | null;
  /**
   * Override the auto-composed aria-label. Default summarizes the y-label,
   * the date range span, and the current value.
   */
  ariaLabel?: string;
}

const DEFAULT_HEIGHT = 200;
const PAD_TOP = 12;
const PAD_BOTTOM = 28;
const PAD_LEFT = 44;
const PAD_RIGHT = 12;

const SEVERITY_COLOR: Record<AnnotationSeverity, string> = {
  info: 'var(--color-secondary-blue, #5A799E)',
  warning: 'var(--color-accent-brass, #A67813)',
  error: 'var(--color-ironwake, #771A1A)',
};

const LINE_COLOR = 'var(--color-primary-navy, #1C2A44)';
const AXIS_COLOR = 'var(--color-deep-charcoal, #4E4C4C)';

function formatValue(value: number, fmt: ValueFormat): string {
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

function trendSummary(data: TimelinePoint[]): string {
  if (data.length === 0) return 'no data';
  if (data.length === 1) return `current ${data[0]!.value}`;
  const first = data[0]!.value;
  const last = data[data.length - 1]!.value;
  if (last > first) return `current ${last}, trend up`;
  if (last < first) return `current ${last}, trend down`;
  return `current ${last}, trend stable`;
}

function composeAriaLabel({
  yLabel,
  data,
}: {
  yLabel: string;
  data: TimelinePoint[];
}): string {
  if (data.length === 0) return `${yLabel} timeline, no data`;
  const days = data.length;
  return `${yLabel} timeline, ${days} day${days === 1 ? '' : 's'}, ${trendSummary(data)}`;
}

interface PlotGeometry {
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  xFor: (idx: number) => number;
  yFor: (value: number) => number;
  yTicks: Array<{ value: number; y: number }>;
}

function computeGeometry(
  data: TimelinePoint[],
  height: number,
): PlotGeometry {
  // We render at a fixed viewBox width (640) and let CSS scale responsively.
  const width = 640;
  const innerWidth = width - PAD_LEFT - PAD_RIGHT;
  const innerHeight = height - PAD_TOP - PAD_BOTTOM;
  const values = data.map((p) => p.value);
  const minRaw = Math.min(...values);
  const maxRaw = Math.max(...values);
  // Avoid zero-range axis when all values are identical.
  const min = minRaw === maxRaw ? minRaw - 1 : minRaw;
  const max = minRaw === maxRaw ? maxRaw + 1 : maxRaw;
  const xFor = (idx: number): number =>
    PAD_LEFT +
    (data.length <= 1 ? innerWidth / 2 : (innerWidth * idx) / (data.length - 1));
  const yFor = (value: number): number =>
    PAD_TOP + innerHeight - ((value - min) / (max - min)) * innerHeight;
  // 4 evenly spaced y-ticks.
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const v = min + ((max - min) * i) / tickCount;
    return { value: v, y: yFor(v) };
  });
  return { width, height, innerWidth, innerHeight, xFor, yFor, yTicks };
}

function buildLinePath(
  data: TimelinePoint[],
  geom: PlotGeometry,
): string {
  return data
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${geom.xFor(i)} ${geom.yFor(p.value)}`)
    .join(' ');
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
  testId = 'timeline-chart',
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

export function TimelineChart({
  data,
  yLabel,
  valueFormat = 'integer',
  annotations = [],
  height = DEFAULT_HEIGHT,
  loading = false,
  error = null,
  ariaLabel,
}: TimelineChartProps): React.ReactElement {
  if (loading) {
    return (
      <ChartShell
        height={height}
        ariaLabel="Loading timeline"
        testId="timeline-chart-skeleton"
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
      <ChartShell height={height} ariaLabel={`Timeline error: ${error}`}>
        <div
          role="alert"
          data-testid="timeline-chart-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          Could not load timeline: {error}
        </div>
      </ChartShell>
    );
  }

  if (data.length === 0) {
    return (
      <ChartShell height={height} ariaLabel={`${yLabel} timeline, no data`}>
        <div
          data-testid="timeline-chart-empty"
          className="flex h-full items-center justify-center rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
          style={{ minHeight: height }}
        >
          No data available
        </div>
      </ChartShell>
    );
  }

  const composedAria = ariaLabel ?? composeAriaLabel({ yLabel, data });
  return (
    <ChartShellSvg
      data={data}
      yLabel={yLabel}
      valueFormat={valueFormat}
      annotations={annotations}
      height={height}
      ariaLabel={composedAria}
    />
  );
}

interface ChartShellSvgProps extends Required<Pick<TimelineChartProps, 'data' | 'yLabel' | 'valueFormat' | 'annotations' | 'height'>> {
  ariaLabel: string;
}

function ChartShellSvg({
  data,
  yLabel,
  valueFormat,
  annotations,
  height,
  ariaLabel,
}: ChartShellSvgProps): React.ReactElement {
  const geom = useMemo(() => computeGeometry(data, height), [data, height]);
  const linePath = useMemo(() => buildLinePath(data, geom), [data, geom]);
  // Index annotations by date so we can position them on the data x-scale.
  const dateToIndex = useMemo(
    () => new Map(data.map((p, i) => [p.date, i])),
    [data],
  );

  return (
    <ChartShell height={height} ariaLabel={ariaLabel}>
      <svg
        viewBox={`0 0 ${geom.width} ${geom.height}`}
        preserveAspectRatio="none"
        width="100%"
        height={geom.height}
        data-testid="timeline-chart-svg"
      >
        {/* Y-axis label rendered vertically left of the axis. */}
        <text
          x={12}
          y={geom.height / 2}
          fill={AXIS_COLOR}
          fontSize="11"
          textAnchor="middle"
          transform={`rotate(-90 12 ${geom.height / 2})`}
          data-testid="timeline-y-label"
        >
          {yLabel}
        </text>
        {/* Y-axis tick gridlines + labels. */}
        {geom.yTicks.map((tick, i) => (
          <g key={`tick-${i}`}>
            <line
              x1={PAD_LEFT}
              x2={geom.width - PAD_RIGHT}
              y1={tick.y}
              y2={tick.y}
              stroke={AXIS_COLOR}
              strokeOpacity="0.1"
              strokeWidth="1"
            />
            <text
              x={PAD_LEFT - 4}
              y={tick.y + 3}
              textAnchor="end"
              fontSize="10"
              fill={AXIS_COLOR}
            >
              {formatValue(Math.round(tick.value), valueFormat)}
            </text>
          </g>
        ))}
        {/* X-axis baseline + endpoint date labels. */}
        <line
          x1={PAD_LEFT}
          x2={geom.width - PAD_RIGHT}
          y1={geom.height - PAD_BOTTOM}
          y2={geom.height - PAD_BOTTOM}
          stroke={AXIS_COLOR}
          strokeWidth="1"
        />
        <text
          x={PAD_LEFT}
          y={geom.height - PAD_BOTTOM + 14}
          fontSize="10"
          fill={AXIS_COLOR}
        >
          {data[0]!.date}
        </text>
        <text
          x={geom.width - PAD_RIGHT}
          y={geom.height - PAD_BOTTOM + 14}
          fontSize="10"
          fill={AXIS_COLOR}
          textAnchor="end"
        >
          {data[data.length - 1]!.date}
        </text>
        {/* Annotation marker lines + invisible tooltip targets. */}
        {annotations.map((a, i) => {
          const idx = dateToIndex.get(a.date);
          if (idx === undefined) return null;
          const x = geom.xFor(idx);
          const severity = a.severity ?? 'info';
          const color = SEVERITY_COLOR[severity];
          return (
            <g
              key={`ann-${i}`}
              data-testid={`timeline-annotation-${severity}-${a.date}`}
            >
              <line
                x1={x}
                x2={x}
                y1={PAD_TOP}
                y2={geom.height - PAD_BOTTOM}
                stroke={color}
                strokeWidth="1.5"
                strokeDasharray="3 2"
              />
              {/* Hover/focus target — title pops native tooltip. */}
              <circle cx={x} cy={PAD_TOP + 4} r={4} fill={color} tabIndex={0}>
                <title>
                  {a.date}: {a.label}
                </title>
              </circle>
            </g>
          );
        })}
        {/* The series line itself. */}
        <path
          d={linePath}
          stroke={LINE_COLOR}
          strokeWidth="1.8"
          fill="none"
        />
        {/* Point dots double as SR-discoverable elements. */}
        {data.map((p, i) => (
          <circle
            key={`pt-${p.date}`}
            cx={geom.xFor(i)}
            cy={geom.yFor(p.value)}
            r={2.5}
            fill={LINE_COLOR}
          >
            <title>
              {p.date}: {formatValue(p.value, valueFormat)}
            </title>
          </circle>
        ))}
      </svg>
      {/* SR data-table fallback — visually hidden, fully readable. */}
      <table className="sr-only" data-testid="timeline-chart-sr-table">
        <caption>{yLabel} time series</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>{yLabel}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{formatValue(p.value, valueFormat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartShell>
  );
}
