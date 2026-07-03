// Authorized by HUB-1683 (E-FE-9 S4) — right-column shell + initial skeleton.
// Authorized by HUB-1684 (E-FE-9 S5) — full signals panel: triple-encoded
// severity icons (color + icon + text), per-signal contribution weight,
// total-score sanity check, last-advisor-run timestamp with "Recent"
// badge, and a "Run Plan Advisor" CTA deep-linking into HUB-1639's New
// Recommendation flow with the productId pre-populated.
//
// Deep-link contract (per ironclad-engineer): the story spec described
// /console/plan-advisor?action=new&tenantId=X&productId=Y. Verified at
// impl against HUB-1639's NewRecommendationFlow — the flow derives
// tenantId from the picked PortfolioProduct + only needed productId to
// be pre-populated. This commit extends NewRecommendationFlow to read
// ?productId= as an initial picker value; no `action=new` param needed
// because the /console/plan-advisor/new route already drops directly
// into the flow. Documented deviation from the spec URL shape.
import { Link } from 'react-router-dom';
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

interface SeverityIconProps {
  severity: 'high' | 'medium' | 'low';
}

function SeverityIcon({ severity }: SeverityIconProps): React.ReactElement {
  const icon = severity === 'high' ? '✕' : severity === 'medium' ? '⚠' : '●';
  const label =
    severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low';
  const classes =
    severity === 'high'
      ? 'border-ironwake/40 bg-ironwake/10 text-ironwake'
      : severity === 'medium'
        ? 'border-accent-brass/40 bg-accent-brass/10 text-accent-brass'
        : 'border-deep-charcoal/25 bg-deep-charcoal/5 text-deep-charcoal/70';
  return (
    <span
      data-testid={`customer-health-signal-severity-${severity}`}
      aria-label={`Severity: ${label}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-body ${classes}`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

function isRecent(iso: string | null): boolean {
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  return age <= 7 * 24 * 60 * 60 * 1000;
}

export function CustomerHealthSignalsPanel({
  signals,
  totalScore,
  lastAdvisorRunAt,
  productId,
}: CustomerHealthSignalsPanelProps): React.ReactElement {
  const advisorRecent = isRecent(lastAdvisorRunAt);
  const advisorDeepLink = `/console/plan-advisor/new?productId=${productId}`;

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
        <ul className="flex flex-col gap-2">
          {signals.map((s) => (
            <li
              key={s.key}
              data-testid={`customer-health-signal-${s.key}`}
              className="flex items-center justify-between gap-2 rounded border border-deep-charcoal/10 bg-white p-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <SeverityIcon severity={s.severity} />
                <span className="min-w-0 text-sm font-body text-deep-charcoal">
                  {s.label}
                </span>
              </div>
              <span
                className="text-xs font-mono text-deep-charcoal/70"
                aria-label={`Contributes ${s.contributesPoints.toFixed(2)} to score`}
              >
                +{s.contributesPoints.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div
        data-testid="customer-health-signals-total"
        className="flex items-center justify-between border-t border-deep-charcoal/10 pt-2 text-xs font-body text-deep-charcoal/70"
      >
        <span>Total churn-risk score</span>
        <span className="font-mono text-sm text-deep-charcoal">
          {totalScore.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-2 text-xs font-body text-deep-charcoal/60">
        <span data-testid="customer-health-signals-advisor-run">
          Last advisor run:{' '}
          {lastAdvisorRunAt
            ? formatRelativeTime(lastAdvisorRunAt)
            : 'No advisor run yet'}
        </span>
        {advisorRecent && (
          <span
            data-testid="customer-health-signals-advisor-recent"
            className="rounded-full bg-seafoam/15 px-2 py-0.5 text-[10px] font-body text-seafoam"
          >
            Recent
          </span>
        )}
      </div>

      <Link
        to={advisorDeepLink}
        data-testid="customer-health-signals-run-advisor"
        className="mt-2 inline-flex items-center justify-center rounded border border-primary-navy/40 bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth no-underline hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        Run Plan Advisor for this tenant
      </Link>
    </aside>
  );
}
