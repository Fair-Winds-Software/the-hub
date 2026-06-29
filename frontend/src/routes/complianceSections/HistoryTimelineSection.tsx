// Authorized by HUB-1624 (E-FE-8 S5) — Verdict History timeline section for the
// HUB-1623 compliance drill-in page. Renders a 90-day posture history line over
// the HUB-1621 <TimelineChart>, with annotation markers placed where the score
// dropped > 5 points day-over-day (warning for 5-10pt; error for >10pt).
//
// Per spec, data is sliced from the drill-in detail response; this section does
// not issue a separate fetch. Empty state links to the HUB-1564 Settings tab
// where compliance evaluation is configured.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  TimelineChart,
  type TimelineAnnotation,
  type TimelinePoint,
} from '../../components/TimelineChart';

const DROP_WARNING_MIN = 5;
const DROP_ERROR_MIN = 10;

export interface VerdictHistoryPoint {
  date: string;
  score: number;
}

export interface HistoryTimelineSectionProps {
  history: VerdictHistoryPoint[];
  loading?: boolean;
  error?: string | null;
}

interface DropDetail {
  date: string;
  previousScore: number;
  currentScore: number;
  dropPoints: number;
}

export function computeDrops(history: VerdictHistoryPoint[]): DropDetail[] {
  const drops: DropDetail[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]!;
    const curr = history[i]!;
    const dropPoints = prev.score - curr.score;
    if (dropPoints > DROP_WARNING_MIN) {
      drops.push({
        date: curr.date,
        previousScore: prev.score,
        currentScore: curr.score,
        dropPoints,
      });
    }
  }
  return drops;
}

function severityForDrop(drop: number): 'warning' | 'error' {
  return drop > DROP_ERROR_MIN ? 'error' : 'warning';
}

export function HistoryTimelineSection({
  history,
  loading = false,
  error = null,
}: HistoryTimelineSectionProps): React.ReactElement {
  const data: TimelinePoint[] = useMemo(
    () => history.map((p) => ({ date: p.date, value: p.score })),
    [history],
  );

  const annotations: TimelineAnnotation[] = useMemo(() => {
    return computeDrops(history).map((d) => ({
      date: d.date,
      label: `Score dropped ${d.dropPoints} points on ${d.date} (was ${d.previousScore}, now ${d.currentScore})`,
      severity: severityForDrop(d.dropPoints),
    }));
  }, [history]);

  if (!loading && error === null && history.length === 0) {
    return (
      <section
        aria-labelledby="history-timeline-heading"
        data-testid="compliance-section-verdict-history"
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
      >
        <h2
          id="history-timeline-heading"
          className="font-heading text-lg text-primary-navy mb-2"
        >
          Verdict History
        </h2>
        <div
          data-testid="history-timeline-empty"
          className="flex flex-col items-start gap-2 text-sm font-body text-deep-charcoal/80"
        >
          <p>No history available — first evaluation pending.</p>
          <Link
            to="/console/settings"
            data-testid="history-timeline-empty-cta"
            className="underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Configure compliance evaluation in Settings
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="history-timeline-heading"
      data-testid="compliance-section-verdict-history"
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h2
        id="history-timeline-heading"
        className="font-heading text-lg text-primary-navy mb-2"
      >
        Verdict History
      </h2>
      <TimelineChart
        data={data}
        yLabel="Posture Score"
        valueFormat="integer"
        annotations={annotations}
        loading={loading}
        error={error}
      />
    </section>
  );
}
