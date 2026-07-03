// Authorized by HUB-1683 (E-FE-9 S4) — skeleton container so S4 shell
// compiles. Full signals panel + Run Plan Advisor deep-link ship in
// HUB-1684 (S5); this stub renders the raw signal list without the
// severity icons + advisor CTA.
import { formatRelativeTime } from './customer-health-formatters';

export interface DrillInSignal {
  key: string;
  label: string;
  severity: 'high' | 'medium' | 'low';
  contributesPoints: number;
  active: true;
}

interface CustomerHealthSignalsPanelProps {
  signals: DrillInSignal[];
  totalScore: number;
  lastAdvisorRunAt: string | null;
  tenantId: string;
  productId: string;
}

export function CustomerHealthSignalsPanel({
  signals,
  totalScore,
  lastAdvisorRunAt,
}: CustomerHealthSignalsPanelProps): React.ReactElement {
  return (
    <aside
      data-testid="customer-health-signals-panel"
      className="flex flex-col gap-3 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h2 className="font-heading text-base text-primary-navy">
        Churn risk signals
      </h2>
      {signals.length === 0 ? (
        <p
          data-testid="customer-health-signals-empty"
          className="rounded border border-seafoam/30 bg-seafoam/5 p-2 text-xs font-body text-seafoam"
        >
          No churn risk signals — this tenant looks healthy.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {signals.map((s) => (
            <li
              key={s.key}
              data-testid={`customer-health-signal-${s.key}`}
              className="flex items-center justify-between gap-2 text-sm font-body text-deep-charcoal"
            >
              <span>{s.label}</span>
              <span className="text-xs font-mono text-deep-charcoal/70">
                +{s.contributesPoints.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs font-body text-deep-charcoal/60">
        Total churn-risk score: {totalScore.toFixed(2)}
      </p>
      <p className="text-xs font-body text-deep-charcoal/60">
        Last advisor run: {lastAdvisorRunAt ? formatRelativeTime(lastAdvisorRunAt) : 'No advisor run yet'}
      </p>
    </aside>
  );
}
