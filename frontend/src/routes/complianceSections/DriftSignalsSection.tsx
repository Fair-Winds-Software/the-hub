// Authorized by HUB-1625 (E-FE-8 S6) — Drift Signals section for the HUB-1623
// compliance drill-in page. Renders a list of controls that changed status in
// the last 30 days (sorted DESC by changed_at) plus a top-of-section drift
// banner when this product is currently breaching the drift threshold.
//
// Data is sliced from the drill-in detail response per spec — no separate fetch.
// Drift threshold defaults to 10pt; the parent passes the resolved
// hub_settings.compliance_drift_threshold_pct value when available.
import { useMemo } from 'react';

const DEFAULT_DRIFT_THRESHOLD = 10;

export interface DriftSignal {
  control_id: string;
  control_name: string;
  status_from: string;
  status_to: string;
  changed_at: string;
}

export interface DriftSignalsSectionProps {
  signals: DriftSignal[];
  /** Current vs. 30-day-ago score; absence means we can't compute drift. */
  currentScore?: number;
  score_30d_ago?: number;
  driftThreshold?: number;
}

type TransitionSeverity = 'info' | 'warning' | 'error';

const TRANSITION_SEVERITY: Record<string, TransitionSeverity> = {
  // Improvements / informational.
  'failing→passing': 'info',
  'passing→passing': 'info',
  // Degradations.
  'passing→failing': 'error',
  'passing→warning': 'warning',
  'warning→failing': 'error',
  // Returns to baseline / status drops to needs-review.
  'failing→warning': 'warning',
  'warning→passing': 'info',
};

function transitionKey(from: string, to: string): string {
  return `${from}→${to}`;
}

function severityFor(from: string, to: string): TransitionSeverity {
  // Fall back to warning when transition isn't pre-classified — defensive,
  // since the BE schema may evolve and we'd rather flag than silently mute.
  return TRANSITION_SEVERITY[transitionKey(from, to)] ?? 'warning';
}

const SEVERITY_TEXT_CLASS: Record<TransitionSeverity, string> = {
  info: 'text-secondary-blue',
  warning: 'text-accent-brass',
  error: 'text-ironwake',
};

const SEVERITY_BG_CLASS: Record<TransitionSeverity, string> = {
  info: 'bg-secondary-blue/10 text-secondary-blue',
  warning: 'bg-accent-brass/10 text-accent-brass',
  error: 'bg-ironwake/10 text-ironwake',
};

function SeverityIcon({
  severity,
}: {
  severity: TransitionSeverity;
}): React.ReactElement {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    'aria-hidden': true as const,
  };
  switch (severity) {
    case 'error':
      return (
        <svg {...common} data-testid={`drift-icon-${severity}`}>
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
          />
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
    case 'warning':
      return (
        <svg {...common} data-testid={`drift-icon-${severity}`}>
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
    case 'info':
    default:
      return (
        <svg {...common} data-testid={`drift-icon-${severity}`}>
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
          />
          <line
            x1="8"
            y1="6"
            x2="8"
            y2="9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11" r="0.8" fill="currentColor" />
        </svg>
      );
  }
}

function CheckIcon(): React.ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      data-testid="drift-empty-check-icon"
    >
      <path
        d="M4 10.5L8 14.5L16 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

interface DriftBannerProps {
  dropPoints: number;
}

function DriftBanner({ dropPoints }: DriftBannerProps): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid="drift-banner"
      className="mb-3 flex items-center gap-2 rounded-md border border-accent-brass/40 bg-accent-brass/5 p-3 text-sm font-body text-accent-brass"
    >
      <SeverityIcon severity="warning" />
      <span>
        <strong>Posture dropped {dropPoints} points in 30 days</strong> — review
        controls below.
      </span>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function DriftSignalsSection({
  signals,
  currentScore,
  score_30d_ago,
  driftThreshold = DEFAULT_DRIFT_THRESHOLD,
}: DriftSignalsSectionProps): React.ReactElement {
  const sortedSignals = useMemo(
    () =>
      [...signals].sort(
        (a, b) =>
          new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime(),
      ),
    [signals],
  );

  const driftDropPoints = useMemo(() => {
    if (typeof currentScore !== 'number' || typeof score_30d_ago !== 'number') {
      return 0;
    }
    return score_30d_ago - currentScore;
  }, [currentScore, score_30d_ago]);
  const isDriftBreach = driftDropPoints > driftThreshold;

  return (
    <section
      aria-labelledby="drift-signals-heading"
      data-testid="compliance-section-drift-signals"
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h2
        id="drift-signals-heading"
        className="font-heading text-lg text-primary-navy mb-2"
      >
        Drift Signals
      </h2>
      {isDriftBreach && <DriftBanner dropPoints={driftDropPoints} />}
      {sortedSignals.length === 0 ? (
        <div
          data-testid="drift-signals-empty"
          className="flex items-center gap-2 rounded-md border border-seafoam/30 bg-seafoam/5 p-3 text-sm font-body text-seafoam"
        >
          <CheckIcon />
          <span>No control status changes in last 30 days.</span>
        </div>
      ) : (
        <ul
          data-testid="drift-signals-list"
          className="flex flex-col gap-1"
        >
          {sortedSignals.map((sig) => {
            const severity = severityFor(sig.status_from, sig.status_to);
            return (
              <li
                key={`${sig.control_id}-${sig.changed_at}`}
                data-testid={`drift-signal-${sig.control_id}`}
                className="grid grid-cols-[20px_1fr_auto_auto] items-center gap-3 border-b border-deep-charcoal/10 py-2 last:border-b-0"
              >
                <span className={SEVERITY_TEXT_CLASS[severity]}>
                  <SeverityIcon severity={severity} />
                </span>
                <span className="font-body text-sm font-medium text-primary-navy">
                  {sig.control_name}
                </span>
                <span
                  data-testid={`drift-signal-transition-${sig.control_id}`}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${SEVERITY_BG_CLASS[severity]}`}
                >
                  {sig.status_from} → {sig.status_to}
                </span>
                <span className="font-body text-xs text-deep-charcoal/60">
                  {formatTimestamp(sig.changed_at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
