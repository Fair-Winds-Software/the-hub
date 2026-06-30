// Authorized by HUB-1640 (E-FE-4 S4) — Recommendation result view at
// /console/plan-advisor/:runId. Renders the prominent "Advisory only" warning
// banner (FR-006) above the product header, then a HUB-1637 PlanComparison
// of current vs recommended plan, then an impact summary, then a stale-
// detection banner when the recommendation is over 30 days old. S5
// (HUB-1641) drops the outcome capture section below this scaffold.
//
// Spec deviations (documented per ironclad-engineer):
// 1. API endpoint: spec named GET /api/v1/admin/plan-advisor/runs/:runId.
//    No single-recommendation GET exists at v0.1. We fetch the
//    /admin/advisor/recommendations list and find by recommendationId.
//    Same fallback pattern as HUB-1623 ComplianceDetail + HUB-1604
//    ProductDetail. When the BE adds a single endpoint, swap is one branch.
// 2. Schema gaps from HUB-1638 spec deviation #3 carry over here:
//    currentPlan = null and operatorEmail = null per HUB-1699. The
//    PlanComparison left card surfaces the empty placeholder; the header
//    Operator field renders '—'. Both backfill cleanly when BE catches up.
// 3. Churn risk is not surfaced by the v0.1 list shape; the impact tile
//    renders '—' with a tooltip referencing the §6 BE caveat.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';
import { AccessDeniedPage } from '../../components/AccessDeniedPage';
import {
  PlanComparison,
  type PlanData,
} from '../../components/PlanComparison';

const RECOMMENDATIONS_PATH = '/api/v1/admin/advisor/recommendations';
const ADVISORY_COPY =
  'Advisory only — never auto-applied. To apply, edit the plan manually.';
const STALE_THRESHOLD_DAYS = 30;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

interface AdvisorListRow {
  recommendationId: string;
  productId: string;
  tenantId: string;
  productName: string | null;
  currentPlan: string | null;
  recommendedPlan: string | null;
  reasoning: string;
  mrrImpact: number | null;
  outcome: string | null;
  outcomeNote: string | null;
  createdAt: string;
  outcomeCapturedAt: string | null;
  operatorEmail: string | null;
}

interface ListResponse {
  data: AdvisorListRow[];
  total: number;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not-found' }
  | { kind: 'denied' }
  | { kind: 'ready'; row: AdvisorListRow };

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return (Date.now() - t) / MILLIS_PER_DAY;
}

function formatDollars(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
    signDisplay: 'always',
  }).format(value);
}

function AdvisoryWarningBanner(): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid="advisory-warning-banner"
      className="flex items-start gap-3 rounded-md border border-accent-brass/40 bg-accent-brass/10 p-4 text-sm font-body text-accent-brass"
    >
      {/* Triple-encoded per AC-E3 + a11y floor: color + icon + text. */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        aria-hidden="true"
        className="mt-0.5 shrink-0"
        data-testid="advisory-warning-icon"
      >
        <path
          d="M9 2L17 15H1L9 2Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          fill="none"
        />
        <line
          x1="9"
          y1="7"
          x2="9"
          y2="11"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="9" cy="13" r="1" fill="currentColor" />
      </svg>
      <p data-testid="advisory-warning-text" className="font-medium">
        {ADVISORY_COPY}
      </p>
    </div>
  );
}

function StaleRecommendationBanner({
  ageDays,
}: {
  ageDays: number;
}): React.ReactElement {
  return (
    <div
      role="status"
      data-testid="stale-recommendation-banner"
      className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
    >
      This recommendation is over {STALE_THRESHOLD_DAYS} days old (
      {Math.floor(ageDays)} days) — consider running a fresh advisor.
    </div>
  );
}

interface ImpactSummaryProps {
  mrrImpact: number | null;
}

function ImpactSummary({ mrrImpact }: ImpactSummaryProps): React.ReactElement {
  const mrrColor =
    mrrImpact === null
      ? 'text-deep-charcoal/60'
      : mrrImpact > 0
        ? 'text-seafoam'
        : mrrImpact < 0
          ? 'text-ironwake'
          : 'text-deep-charcoal';
  return (
    <section
      aria-labelledby="impact-summary-heading"
      data-testid="impact-summary"
      className="grid grid-cols-1 gap-3 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 lg:grid-cols-2"
    >
      <h2 id="impact-summary-heading" className="sr-only">
        Impact summary
      </h2>
      <div data-testid="impact-mrr">
        <p className="font-body text-xs text-deep-charcoal/70">
          Estimated MRR impact
        </p>
        <p
          data-testid="impact-mrr-value"
          className={`font-heading text-2xl ${mrrColor}`}
        >
          {mrrImpact === null ? '—' : `${formatDollars(mrrImpact)}/mo`}
        </p>
      </div>
      <div data-testid="impact-churn-risk">
        <p className="font-body text-xs text-deep-charcoal/70">
          Churn-risk indicator
        </p>
        <p
          data-testid="impact-churn-risk-value"
          title="Churn risk is not surfaced by the v0.1 advisor list response. Reserved for a future BE expansion."
          className="font-heading text-2xl text-deep-charcoal/60"
        >
          —
        </p>
      </div>
    </section>
  );
}

function HeaderSkeleton(): React.ReactElement {
  return (
    <div
      data-testid="recommendation-header-skeleton"
      className="flex flex-col gap-2"
    >
      <div className="h-7 w-64 animate-pulse rounded bg-deep-charcoal/10" />
      <div className="h-4 w-40 animate-pulse rounded bg-deep-charcoal/10" />
    </div>
  );
}

export default function RecommendationResultView(): React.ReactElement {
  const { runId = '' } = useParams<{ runId: string }>();
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void apiClient
      .get<ListResponse>(RECOMMENDATIONS_PATH)
      .then((res) => {
        if (cancelled) return;
        const match = res.data.find(
          (r) => r.recommendationId === runId,
        );
        if (!match) {
          setState({ kind: 'not-found' });
          return;
        }
        setState({ kind: 'ready', row: match });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof PermissionDeniedError) {
          setState({ kind: 'denied' });
          return;
        }
        if (
          err instanceof Error &&
          /(\b404\b|not found)/i.test(err.message)
        ) {
          setState({ kind: 'not-found' });
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Failed to load recommendation';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    const prev = document.title;
    if (state.kind === 'ready') {
      const name = state.row.productName ?? 'product';
      document.title = `Recommendation for ${name} | Plan Advisor | HUB Console`;
    } else {
      document.title = 'Recommendation | Plan Advisor | HUB Console';
    }
    return () => {
      document.title = prev;
    };
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="recommendation-result-page"
        className="flex flex-col gap-4"
      >
        <AdvisoryWarningBanner />
        <HeaderSkeleton />
        <div
          data-testid="recommendation-comparison-skeleton"
          className="h-48 animate-pulse rounded-md bg-deep-charcoal/10"
        />
        <div className="h-24 animate-pulse rounded-md bg-deep-charcoal/10" />
      </div>
    );
  }

  if (state.kind === 'denied') {
    return (
      <div
        id="main-content"
        data-testid="recommendation-result-page"
        className="flex flex-col gap-4"
      >
        <AccessDeniedPage
          resourceLabel="this recommendation"
          backTo="/console/plan-advisor"
          backLabel="Back to advisor list"
        />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        data-testid="recommendation-result-page"
        className="flex flex-col gap-4"
      >
        <div
          role="alert"
          data-testid="recommendation-error-banner"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Could not load recommendation.</p>
          <p className="mt-1">{state.message}</p>
          <Link
            to="/console/plan-advisor"
            className="mt-2 inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Back to advisor list
          </Link>
        </div>
      </div>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <div
        id="main-content"
        data-testid="recommendation-result-page"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="recommendation-not-found"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal"
        >
          <p className="font-medium">Recommendation not found.</p>
          <p className="mt-1">
            We couldn&apos;t find a recommendation with id <code>{runId}</code>{' '}
            in your accessible advisor history.
          </p>
          <Link
            to="/console/plan-advisor"
            className="mt-2 inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Back to advisor list
          </Link>
        </div>
      </div>
    );
  }

  const row = state.row;
  const ageDays = daysSince(row.createdAt);
  const isStale = ageDays > STALE_THRESHOLD_DAYS;
  const left: PlanData | null = row.currentPlan
    ? { title: row.currentPlan }
    : null;
  const right: PlanData | null = row.recommendedPlan
    ? { title: row.recommendedPlan }
    : null;
  const reasoningBullets = row.reasoning
    ? row.reasoning
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];

  return (
    <div
      id="main-content"
      data-testid="recommendation-result-page"
      className="flex flex-col gap-4"
    >
      <AdvisoryWarningBanner />

      <header className="flex flex-col gap-1">
        <h1
          data-testid="recommendation-product-heading"
          className="font-heading text-2xl text-primary-navy"
        >
          {row.productName ?? '(unnamed product)'}
        </h1>
        <p className="font-body text-sm text-deep-charcoal/70">
          Recommendation generated{' '}
          <span data-testid="recommendation-timestamp">
            {new Date(row.createdAt).toLocaleString()}
          </span>{' '}
          · Operator:{' '}
          <span data-testid="recommendation-operator">
            {row.operatorEmail ?? '—'}
          </span>
        </p>
      </header>

      {isStale && <StaleRecommendationBanner ageDays={ageDays} />}

      <section aria-labelledby="plan-comparison-section-heading">
        <h2
          id="plan-comparison-section-heading"
          className="sr-only"
        >
          Plan comparison
        </h2>
        <PlanComparison
          left={left}
          right={right}
          reasoningBullets={
            reasoningBullets.length > 0 ? reasoningBullets : undefined
          }
        />
      </section>

      <ImpactSummary mrrImpact={row.mrrImpact} />

      <section
        aria-labelledby="outcome-capture-heading"
        data-testid="outcome-capture-placeholder"
        className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
      >
        <h2
          id="outcome-capture-heading"
          className="font-heading text-lg text-primary-navy mb-1"
        >
          Outcome
        </h2>
        <p className="font-body text-sm text-deep-charcoal/70">
          Outcome capture lands in HUB-1641 (S5).
        </p>
      </section>
    </div>
  );
}
