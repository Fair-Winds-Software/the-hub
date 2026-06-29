// Authorized by HUB-1623 (E-FE-8 S4) — /console/compliance/:productId drill-in
// scaffold. Renders a product header (name + current posture + verdict badge)
// above three vertical sections, each wrapped in its own error boundary:
//   1. Verdict History (HUB-1624 S5)
//   2. Drift Signals (HUB-1625 S6)
//   3. Per-Control Breakdown (HUB-1626 S7)
//
// Per-section error boundary contract: one section's throw renders only its
// section's fallback; the other two stay functional. Matches the HUB-1559 §9
// Reliability NFR ("detail view renders even if a sub-tab's data fails").
//
// Spec deviations (documented per ironclad-engineer):
// 1. API endpoint: spec named GET /api/v1/admin/compliance/:productId. The
//    HUB backend at v0.1 does not yet expose this — flagged in the spec's §6
//    caveat. Fetch fires per spec; on 404 / network the page surfaces the
//    full-page error UX. When the endpoint lands, no FE changes needed.
// 2. Sibling section components are placeholders at S4; sibling stories
//    S5/S6/S7 fill them in.
import {
  Component,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';
import {
  HistoryTimelineSection,
  type VerdictHistoryPoint,
} from './complianceSections/HistoryTimelineSection';
import {
  DriftSignalsSection,
  type DriftSignal,
} from './complianceSections/DriftSignalsSection';

const DETAIL_PATH = (productId: string): string =>
  `/api/v1/admin/compliance/${productId}`;

export interface ComplianceDetail {
  productId: string;
  productName: string;
  score: number;
  /** Trailing 30-day baseline used by the drift signal computation. */
  score_30d_ago?: number;
  last_evaluated_at: string | null;
  /** Up to 90 days of historical posture scores; sliced by HUB-1624. */
  history?: VerdictHistoryPoint[];
  /** Controls that changed status in the last 30 days; sliced by HUB-1625. */
  drift_signals?: DriftSignal[];
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not-found' }
  | { kind: 'denied' }
  | { kind: 'ready'; product: ComplianceDetail };

interface SectionErrorBoundaryProps {
  /** Section name woven into the default fallback copy. */
  name: string;
  children: ReactNode;
}

interface SectionErrorBoundaryState {
  hasError: boolean;
}

export class ComplianceSectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  SectionErrorBoundaryState
> {
  state: SectionErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SectionErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.error(
      `ComplianceDetail: section "${this.props.name}" threw —`,
      error,
    );
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          data-testid={`compliance-section-fallback-${this.props.name}`}
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
        >
          Failed to load {this.props.name}. Refresh to retry.
        </div>
      );
    }
    return this.props.children;
  }
}

function scoreVerdictLabel(score: number): {
  label: string;
  className: string;
} {
  if (score >= 85)
    return {
      label: 'healthy',
      className: 'bg-seafoam/15 text-seafoam',
    };
  if (score >= 60)
    return {
      label: 'warning',
      className: 'bg-accent-brass/15 text-accent-brass',
    };
  return {
    label: 'error',
    className: 'bg-ironwake/15 text-ironwake',
  };
}

function HeaderSkeleton(): React.ReactElement {
  return (
    <div
      data-testid="compliance-detail-header-skeleton"
      className="flex flex-col gap-2"
    >
      <div className="h-7 w-48 animate-pulse rounded bg-deep-charcoal/10" />
      <div className="h-4 w-32 animate-pulse rounded bg-deep-charcoal/10" />
    </div>
  );
}

function SectionSkeleton({ id }: { id: string }): React.ReactElement {
  return (
    <div
      data-testid={`compliance-section-skeleton-${id}`}
      className="h-32 w-full animate-pulse rounded-md border border-deep-charcoal/10 bg-deep-charcoal/5"
    />
  );
}

interface SectionPlaceholderProps {
  id: string;
  title: string;
  story: string;
}

function SectionPlaceholder({
  id,
  title,
  story,
}: SectionPlaceholderProps): React.ReactElement {
  return (
    <section
      aria-labelledby={`section-${id}-heading`}
      data-testid={`compliance-section-${id}`}
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h2
        id={`section-${id}-heading`}
        className="font-heading text-lg text-primary-navy"
      >
        {title}
      </h2>
      <p className="mt-2 text-sm font-body text-deep-charcoal/70">
        {title} section content lands in {story}.
      </p>
    </section>
  );
}

export default function ComplianceDetail(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    const prev = document.title;
    document.title = 'Compliance | HUB Console';
    return () => {
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    if (state.kind === 'ready') {
      document.title = `${state.product.productName} | Compliance | HUB Console`;
    }
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void apiClient
      .get<ComplianceDetail | { error?: string }>(DETAIL_PATH(productId))
      .then((res) => {
        if (cancelled) return;
        // Treat a missing productId field as the "not in compliance system"
        // signal (BE may also throw 404; this is the defensive read).
        if (!('productId' in res) || !res.productId) {
          setState({ kind: 'not-found' });
          return;
        }
        setState({ kind: 'ready', product: res as ComplianceDetail });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof PermissionDeniedError) {
          setState({ kind: 'denied' });
          return;
        }
        // Match HUB-1604: 404 from the BE detail endpoint shows up as an
        // Error with "404" in the message via apiClient classification.
        if (
          err instanceof Error &&
          /(\b404\b|not found)/i.test(err.message)
        ) {
          setState({ kind: 'not-found' });
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Failed to load product';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (state.kind === 'loading') {
    return (
      <div
        id="main-content"
        data-testid="compliance-detail-page"
        className="flex flex-col gap-4"
      >
        <HeaderSkeleton />
        <SectionSkeleton id="verdict-history" />
        <SectionSkeleton id="drift-signals" />
        <SectionSkeleton id="per-control" />
      </div>
    );
  }

  if (state.kind === 'denied') {
    return (
      <div
        id="main-content"
        data-testid="compliance-detail-page"
        className="flex flex-col gap-4"
      >
        <AccessDeniedPage
          resourceLabel="this product's compliance posture"
          backTo="/console/compliance"
          backLabel="Back to Compliance"
        />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        data-testid="compliance-detail-page"
        className="flex flex-col gap-4"
      >
        <div
          role="alert"
          data-testid="compliance-detail-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Could not load compliance posture.</p>
          <p className="mt-1">{state.message}</p>
          <Link
            to="/console/compliance"
            className="mt-2 inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Back to Compliance
          </Link>
        </div>
      </div>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <div
        id="main-content"
        data-testid="compliance-detail-page"
        className="flex flex-col gap-4"
      >
        <div
          data-testid="compliance-detail-not-found"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal"
        >
          <p className="font-medium">
            Product not found in compliance system.
          </p>
          <p className="mt-1">
            We couldn&apos;t find compliance data for product id{' '}
            <code>{productId}</code>. It may not have an evaluator configured.
          </p>
          <Link
            to="/console/compliance"
            className="mt-2 inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Back to Compliance
          </Link>
        </div>
      </div>
    );
  }

  const product = state.product;
  const verdict = scoreVerdictLabel(product.score);
  return (
    <div
      id="main-content"
      data-testid="compliance-detail-page"
      className="flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1
            data-testid="compliance-detail-name"
            className="font-heading text-2xl text-primary-navy"
          >
            {product.productName}
          </h1>
          <span
            data-testid="compliance-detail-verdict-badge"
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-body ${verdict.className}`}
          >
            {verdict.label}
          </span>
        </div>
        <p className="font-body text-sm text-deep-charcoal/70">
          Posture score:{' '}
          <strong
            data-testid="compliance-detail-score"
            className="text-primary-navy"
          >
            {product.score}
          </strong>
          {product.last_evaluated_at && (
            <>
              {' '}
              · Evaluated{' '}
              {new Date(product.last_evaluated_at).toLocaleString()}
            </>
          )}
        </p>
      </header>

      <ComplianceSectionErrorBoundary name="verdict-history">
        <HistoryTimelineSection history={product.history ?? []} />
      </ComplianceSectionErrorBoundary>

      <ComplianceSectionErrorBoundary name="drift-signals">
        <DriftSignalsSection
          signals={product.drift_signals ?? []}
          currentScore={product.score}
          score_30d_ago={product.score_30d_ago}
        />
      </ComplianceSectionErrorBoundary>

      <ComplianceSectionErrorBoundary name="per-control">
        <SectionPlaceholder
          id="per-control"
          title="Per-Control Breakdown"
          story="HUB-1626 (S7)"
        />
      </ComplianceSectionErrorBoundary>
    </div>
  );
}
