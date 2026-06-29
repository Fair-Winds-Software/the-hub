// Authorized by HUB-1622 (E-FE-8 S3) — /console/compliance portfolio grid.
// Renders one HUB-1620 <MetricTile> per HUB-tracked product with posture score,
// verdict (green ≥85 / yellow 60-84 / red <60), last-evaluated timestamp, and a
// drift visual (red border + warning badge) when the score dropped > threshold
// over the trailing 30 days. Framework filter dropdown re-fetches with
// ?framework=<id>.
//
// Spec deviations (documented per ironclad-engineer):
// 1. API endpoint: spec named GET /api/v1/admin/compliance/portfolio. The HUB
//    backend at v0.1 does not yet expose this — flagged in the spec itself
//    (§6 caveat). The fetch fires per spec; on 404 / network failure the page
//    surfaces the error banner with a Retry affordance. When the BE endpoint
//    lands, no FE changes needed. Same pattern as the OverviewTab /health
//    probe in HUB-1605.
// 2. Drift threshold source: spec says "read from hub_settings.
//    compliance_drift_threshold_pct". HUB-1573 settings endpoint exists
//    (GET /api/v1/admin/settings) but the catalog key may not be populated
//    yet. We GET settings in parallel with the portfolio fetch; on either
//    failure we fall back to the 10pt default per the spec's mitigation rule
//    (HUB-1559 §9 Risk-2).
// 3. Drift computation: spec says "client-side over per-product history
//    snippet". The portfolio response shape includes a `score_30d_ago` field
//    per AC#11. If the field is missing, drift is treated as 0 (no badge).
//    Future: BE could pre-compute drift; FE swap is one branch.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MetricTile, type MetricVerdict } from '../components/MetricTile';
import { apiClient } from '../lib/api';
import { PermissionDeniedError } from '../lib/errors';
import { AccessDeniedPage } from '../components/AccessDeniedPage';

const PORTFOLIO_PATH = '/api/v1/admin/compliance/portfolio';
const SETTINGS_PATH = '/api/v1/admin/settings';
const DEFAULT_DRIFT_THRESHOLD = 10;
const DRIFT_SETTING_KEY = 'compliance_drift_threshold_pct';
const PAGE_TITLE = 'Compliance | HUB Console';

export type ComplianceFramework = 'all' | 'soc2' | 'iso27001' | 'custom';

const FRAMEWORK_OPTIONS: Array<{ value: ComplianceFramework; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'soc2', label: 'SOC 2' },
  { value: 'iso27001', label: 'ISO 27001' },
  { value: 'custom', label: 'Custom internal' },
];

export interface CompliancePortfolioRow {
  productId: string;
  productName: string;
  score: number;
  /** Trailing 30-day comparison snapshot for drift compute. */
  score_30d_ago?: number;
  /** ISO timestamp; null when never evaluated. */
  last_evaluated_at: string | null;
}

interface PortfolioResponse {
  data: CompliancePortfolioRow[];
  total: number;
}

interface SettingsResponse {
  data: Record<string, number | string | boolean | null>;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; rows: CompliancePortfolioRow[] };

function scoreToVerdict(score: number): MetricVerdict {
  if (score >= 85) return 'success';
  if (score >= 60) return 'warning';
  return 'error';
}

function formatLastEvaluated(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function driftPoints(row: CompliancePortfolioRow): number {
  if (typeof row.score_30d_ago !== 'number') return 0;
  return row.score - row.score_30d_ago;
}

export default function Compliance(): React.ReactElement {
  const navigate = useNavigate();
  const [framework, setFramework] = useState<ComplianceFramework>('all');
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const [driftThreshold, setDriftThreshold] = useState<number>(
    DEFAULT_DRIFT_THRESHOLD,
  );

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const loadPortfolio = useCallback(
    async (selectedFramework: ComplianceFramework): Promise<void> => {
      setState({ kind: 'loading' });
      const params = new URLSearchParams();
      if (selectedFramework !== 'all') {
        params.set('framework', selectedFramework);
      }
      const qs = params.toString();
      const url = qs ? `${PORTFOLIO_PATH}?${qs}` : PORTFOLIO_PATH;
      try {
        const res = await apiClient.get<PortfolioResponse>(url);
        setState({ kind: 'ready', rows: res.data });
      } catch (err) {
        if (err instanceof PermissionDeniedError) {
          setState({ kind: 'denied' });
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Failed to load portfolio';
        setState({ kind: 'error', message });
      }
    },
    [],
  );

  // Initial + framework-change fetch.
  useEffect(() => {
    void loadPortfolio(framework);
  }, [framework, loadPortfolio]);

  // Drift threshold lookup; non-fatal on failure (falls back to 10).
  useEffect(() => {
    let cancelled = false;
    void apiClient
      .get<SettingsResponse>(SETTINGS_PATH)
      .then((res) => {
        if (cancelled) return;
        const value = res.data?.[DRIFT_SETTING_KEY];
        if (typeof value === 'number' && value > 0) {
          setDriftThreshold(value);
        }
      })
      .catch(() => {
        // Stay on the default; spec explicitly contemplates this.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFrameworkChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setFramework(event.target.value as ComplianceFramework);
    },
    [],
  );

  const handleTileClick = useCallback(
    (row: CompliancePortfolioRow) => {
      navigate(`/console/compliance/${row.productId}`);
    },
    [navigate],
  );

  const tiles = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return state.rows.map((row) => {
      const verdict = scoreToVerdict(row.score);
      const drift = driftPoints(row);
      const isDriftBreach = drift < -driftThreshold;
      const driftBadge = isDriftBreach ? (
        <span
          data-testid={`drift-breach-${row.productId}`}
          className="inline-flex items-center rounded-full bg-ironwake/10 px-2 py-0.5 text-xs text-ironwake"
        >
          Drift: {drift}pt in 30d
        </span>
      ) : null;
      return (
        <li
          key={row.productId}
          data-testid={`compliance-tile-${row.productId}`}
          className={
            isDriftBreach
              ? 'rounded-md ring-2 ring-ironwake/40'
              : ''
          }
        >
          <MetricTile
            title={row.productName}
            value={row.score}
            verdict={verdict}
            footer={
              <div className="flex flex-col gap-1">
                <span>Evaluated: {formatLastEvaluated(row.last_evaluated_at)}</span>
                {driftBadge}
              </div>
            }
            onClick={() => handleTileClick(row)}
          />
        </li>
      );
    });
  }, [state, driftThreshold, handleTileClick]);

  if (state.kind === 'denied') {
    return (
      <div id="main-content" data-testid="compliance-page" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="the compliance dashboard"
          backTo="/console/dashboard"
          backLabel="Back to dashboard"
        />
      </div>
    );
  }

  return (
    <div
      id="main-content"
      data-testid="compliance-page"
      className="flex flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl text-primary-navy">Compliance</h1>
        <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
          Framework
          <select
            data-testid="compliance-framework-filter"
            value={framework}
            onChange={handleFrameworkChange}
            className="rounded border border-deep-charcoal/20 bg-white p-1 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {FRAMEWORK_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {state.kind === 'error' && (
        <div
          role="alert"
          data-testid="compliance-error-banner"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Could not load compliance posture.</p>
          <p className="mt-1">{state.message}</p>
          <button
            type="button"
            onClick={() => void loadPortfolio(framework)}
            className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === 'loading' && (
        // role="list" is required per HUB-1622 spec AC (FE a11y) to defeat
        // Safari's reader-mode list-stripping behavior when `list-style:none`
        // is in effect via the Tailwind grid utilities.
        // eslint-disable-next-line jsx-a11y/no-redundant-roles
        <ul
          role="list"
          data-testid="compliance-grid-loading"
          className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <li key={i}>
              <MetricTile title="" value={null} loading />
            </li>
          ))}
        </ul>
      )}

      {state.kind === 'ready' && state.rows.length === 0 && (
        <div
          data-testid="compliance-empty-state"
          className="flex flex-col items-start gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-6 text-sm font-body text-deep-charcoal/80"
        >
          <p>No compliance data yet — controls evaluated nightly.</p>
          <a
            href="/console/settings"
            className="underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Configure compliance evaluation in Settings
          </a>
        </div>
      )}

      {state.kind === 'ready' && state.rows.length > 0 && (
        <section aria-labelledby="compliance-portfolio-heading">
          <h2
            id="compliance-portfolio-heading"
            className="sr-only"
          >
            Portfolio
          </h2>
          {/* role="list" justification — same Safari reader-mode reason as
              the loading skeleton above. */}
          {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
          <ul
            role="list"
            data-testid="compliance-grid"
            className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {tiles}
          </ul>
        </section>
      )}
    </div>
  );
}
