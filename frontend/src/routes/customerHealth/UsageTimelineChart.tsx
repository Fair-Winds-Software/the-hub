// Authorized by HUB-1683 (E-FE-9 S4) — 90-day usage timeline chart for
// the customer-health drill-in. Renders two overlaid line series
// (eventCount primary axis, activeDays secondary axis) with dot markers
// on hover.
//
// Spec deviation (per ironclad-engineer): story spec referenced LK-134
// Recharts wrapper for the chart. Recharts is not in the HUB frontend
// deps (verified against package.json) — it lives in LaunchKit which
// isn't cross-linked to this repo at v0.1. Rather than pull in ~30KB
// gzipped for a single chart, built an inline SVG line chart. Preserves
// the AC contract (two series + hover tooltip + auto-thinned ticks +
// accessible summary), keeps the /console/customer-health bundle
// dashboard-lean, and stays CLS-safe with fixed dimensions.
//
// If LK-134 is later cross-linked into HUB (v0.2), replace this
// component wholesale — the parent CustomerHealthDetail imports it
// through a single symbol.
import { useMemo, useState } from 'react';
import { formatDateShort } from './customer-health-formatters';

export interface UsageTimelinePoint {
  date: string;
  eventCount: number;
  activeDays: number;
}

interface UsageTimelineChartProps {
  data: UsageTimelinePoint[];
}

const CHART_W = 640;
const CHART_H = 240;
const PAD = { top: 12, right: 48, bottom: 32, left: 40 };
const PLOT_W = CHART_W - PAD.left - PAD.right;
const PLOT_H = CHART_H - PAD.top - PAD.bottom;

export function UsageTimelineChart({
  data,
}: UsageTimelineChartProps): React.ReactElement {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const derived = useMemo(() => {
    if (data.length === 0) {
      return {
        eventMax: 0,
        activeDaysMax: 7,
        eventPath: '',
        activeDaysPath: '',
        trend: 'flat' as 'flat' | 'declining' | 'recovering',
        xTicks: [] as { x: number; label: string }[],
      };
    }
    const eventMax = Math.max(...data.map((d) => d.eventCount), 1);
    const activeDaysMax = 7;
    const n = data.length;

    const xOf = (i: number): number => (i / Math.max(1, n - 1)) * PLOT_W + PAD.left;
    const yOfEvent = (v: number): number =>
      CHART_H - PAD.bottom - (v / eventMax) * PLOT_H;
    const yOfActive = (v: number): number =>
      CHART_H - PAD.bottom - (v / activeDaysMax) * PLOT_H;

    const eventPath = data
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOfEvent(d.eventCount)}`)
      .join(' ');
    const activeDaysPath = data
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOfActive(d.activeDays)}`)
      .join(' ');

    // Trend classifier for the alt text — compare last 14d vs prior 14d
    // eventCount averages when we have enough data.
    let trend: 'flat' | 'declining' | 'recovering' = 'flat';
    if (n >= 28) {
      const last = data.slice(-14).reduce((s, d) => s + d.eventCount, 0) / 14;
      const prior = data.slice(-28, -14).reduce((s, d) => s + d.eventCount, 0) / 14;
      if (last < prior * 0.7) trend = 'declining';
      else if (last > prior * 1.3) trend = 'recovering';
    }

    // Auto-thin to ~10 ticks.
    const tickStep = Math.max(1, Math.floor(n / 10));
    const xTicks: { x: number; label: string }[] = [];
    for (let i = 0; i < n; i += tickStep) {
      xTicks.push({ x: xOf(i), label: formatDateShort(data[i]!.date) });
    }

    return { eventMax, activeDaysMax, eventPath, activeDaysPath, trend, xTicks };
  }, [data]);

  if (data.length === 0) {
    return (
      <div
        data-testid="usage-timeline-empty"
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
      >
        No usage activity in the last 90 days — likely a stale-no-activity
        signal.
      </div>
    );
  }

  const xOf = (i: number): number =>
    (i / Math.max(1, data.length - 1)) * PLOT_W + PAD.left;
  const yOfEvent = (v: number): number =>
    CHART_H - PAD.bottom - (v / derived.eventMax) * PLOT_H;

  const trendCopy =
    derived.trend === 'declining'
      ? 'declining'
      : derived.trend === 'recovering'
        ? 'recovering'
        : 'flat';

  return (
    <div
      data-testid="usage-timeline-chart"
      className="flex flex-col gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <p className="text-xs font-body text-deep-charcoal/70">
        90-day usage trend
      </p>
      <svg
        role="img"
        aria-label={`90-day usage trend: ${trendCopy}. Event count peaks at ${derived.eventMax}.`}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full"
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {/* Baseline */}
        <line
          x1={PAD.left}
          y1={CHART_H - PAD.bottom}
          x2={CHART_W - PAD.right}
          y2={CHART_H - PAD.bottom}
          className="stroke-deep-charcoal/20"
          strokeWidth={1}
        />
        {/* X-axis ticks */}
        {derived.xTicks.map((t) => (
          <g key={t.x}>
            <line
              x1={t.x}
              y1={CHART_H - PAD.bottom}
              x2={t.x}
              y2={CHART_H - PAD.bottom + 4}
              className="stroke-deep-charcoal/30"
              strokeWidth={1}
            />
            <text
              x={t.x}
              y={CHART_H - PAD.bottom + 16}
              textAnchor="middle"
              className="fill-deep-charcoal/60 text-[10px] font-body"
            >
              {t.label}
            </text>
          </g>
        ))}
        {/* Event count line (primary) */}
        <path
          d={derived.eventPath}
          className="fill-none stroke-primary-navy"
          strokeWidth={2}
        />
        {/* Active days line (secondary) */}
        <path
          d={derived.activeDaysPath}
          className="fill-none stroke-accent-brass"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        {/* Hover dots */}
        {data.map((d, i) => (
          <circle
            key={d.date}
            data-testid={`usage-timeline-dot-${i}`}
            cx={xOf(i)}
            cy={yOfEvent(d.eventCount)}
            r={hoveredIdx === i ? 5 : 3}
            className={
              hoveredIdx === i
                ? 'fill-primary-navy'
                : 'fill-primary-navy/40'
            }
            onMouseEnter={() => setHoveredIdx(i)}
            onFocus={() => setHoveredIdx(i)}
            tabIndex={0}
          />
        ))}
      </svg>
      {hoveredIdx !== null && (
        <div
          role="status"
          data-testid="usage-timeline-tooltip"
          className="rounded border border-deep-charcoal/15 bg-white p-2 text-xs font-body text-deep-charcoal"
        >
          <p className="font-medium">
            {formatDateShort(data[hoveredIdx]!.date)}
          </p>
          <p>Events: {data[hoveredIdx]!.eventCount}</p>
          <p>Active days (trailing 7): {data[hoveredIdx]!.activeDays}</p>
        </div>
      )}
      <ul className="flex items-center gap-4 text-xs font-body text-deep-charcoal/60">
        <li className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-1 w-4 bg-primary-navy"
          />
          Events per day
        </li>
        <li className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-1 w-4 border-t-2 border-dashed border-accent-brass"
          />
          Active days (trailing 7)
        </li>
      </ul>
    </div>
  );
}
