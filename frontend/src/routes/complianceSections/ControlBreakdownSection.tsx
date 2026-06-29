// Authorized by HUB-1626 (E-FE-8 S7) — Per-control breakdown table for the
// HUB-1623 compliance drill-in page. Renders the full control catalog for this
// product over the HUB-1601 DataTable with sortable columns and the canonical
// color + icon + text status verdict. Data is sliced from the drill-in detail
// response per spec — no separate fetch.
//
// Default sort: Status with the failing-first order (failing < warning <
// passing) so operators see the controls that need attention at the top.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DataTable, type ColumnDef } from '../../components/DataTable';

export type ControlStatus = 'passing' | 'warning' | 'failing' | string;

export interface ControlRow {
  control_id: string;
  framework: string;
  control_name: string;
  status: ControlStatus;
  last_evaluated_at: string | null;
  evidence_url?: string | null;
}

export interface ControlBreakdownSectionProps {
  controls: ControlRow[];
  loading?: boolean;
  error?: string | null;
}

const STATUS_SORT_ORDER: Record<string, number> = {
  failing: 0,
  warning: 1,
  passing: 2,
};

function sortValueForStatus(status: string): number {
  // Unknown statuses sort to the end so the canonical failing-first ordering
  // doesn't get poisoned by future schema additions.
  return STATUS_SORT_ORDER[status] ?? 99;
}

const STATUS_TEXT_CLASS: Record<string, string> = {
  passing: 'text-seafoam',
  warning: 'text-accent-brass',
  failing: 'text-ironwake',
};

function StatusIcon({ status }: { status: ControlStatus }): React.ReactElement {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    'aria-hidden': true as const,
  };
  if (status === 'passing') {
    return (
      <svg {...common} data-testid="control-status-icon-passing">
        <path
          d="M3.5 8.5L6.5 11.5L12.5 5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }
  if (status === 'warning') {
    return (
      <svg {...common} data-testid="control-status-icon-warning">
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
  }
  if (status === 'failing') {
    return (
      <svg {...common} data-testid="control-status-icon-failing">
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
  }
  return (
    <svg {...common} data-testid="control-status-icon-unknown">
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

function StatusCell({ status }: { status: ControlStatus }): React.ReactElement {
  return (
    <span
      data-testid={`control-status-${status}`}
      className={`inline-flex items-center gap-1 text-sm font-body ${
        STATUS_TEXT_CLASS[status] ?? 'text-deep-charcoal/70'
      }`}
    >
      <StatusIcon status={status} />
      <span>{status}</span>
    </span>
  );
}

function EvidenceCell({
  controlId,
  url,
}: {
  controlId: string;
  url: string | null | undefined;
}): React.ReactElement {
  if (!url) {
    return (
      <span
        data-testid={`control-evidence-empty-${controlId}`}
        className="text-deep-charcoal/40"
      >
        —
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Evidence for ${controlId} (opens in a new tab)`}
      data-testid={`control-evidence-link-${controlId}`}
      className="inline-flex items-center gap-1 text-sm text-secondary-blue underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
    >
      Evidence
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        aria-hidden="true"
      >
        <path
          d="M2 2H6V3H3.5L8 7.5L7.5 8L3 3.5V6H2V2Z"
          fill="currentColor"
        />
      </svg>
    </a>
  );
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function ControlBreakdownSection({
  controls,
  loading = false,
  error = null,
}: ControlBreakdownSectionProps): React.ReactElement {
  const columns: ColumnDef<ControlRow>[] = useMemo(
    () => [
      {
        key: 'control_id',
        header: 'Control ID',
        render: (r) => r.control_id,
        sortable: true,
        sortValue: (r) => r.control_id,
        searchValue: (r) => `${r.control_id} ${r.control_name}`,
      },
      {
        key: 'framework',
        header: 'Framework',
        render: (r) => r.framework,
        sortable: true,
        sortValue: (r) => r.framework,
      },
      {
        key: 'control_name',
        header: 'Control Name',
        render: (r) => r.control_name,
      },
      {
        key: 'status',
        header: 'Status',
        render: (r) => <StatusCell status={r.status} />,
        sortable: true,
        // Numeric sort by failing-first ordering so the default desc/asc
        // produces the spec's "red → yellow → green" sequence.
        sortValue: (r) => sortValueForStatus(r.status),
      },
      {
        key: 'last_evaluated_at',
        header: 'Last Evaluated',
        render: (r) => formatTimestamp(r.last_evaluated_at),
        sortable: true,
        sortValue: (r) =>
          r.last_evaluated_at ? new Date(r.last_evaluated_at) : new Date(0),
      },
      {
        key: 'evidence',
        header: 'Evidence',
        render: (r) => (
          <EvidenceCell controlId={r.control_id} url={r.evidence_url} />
        ),
      },
    ],
    [],
  );

  return (
    <section
      aria-labelledby="control-breakdown-heading"
      data-testid="compliance-section-per-control"
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h2
        id="control-breakdown-heading"
        className="font-heading text-lg text-primary-navy mb-2"
      >
        Per-Control Breakdown
      </h2>
      <DataTable<ControlRow>
        columns={columns}
        rows={controls}
        pageSize={25}
        defaultSort={{ key: 'status', direction: 'asc' }}
        searchableColumns={['control_id']}
        loading={loading}
        error={error}
        emptyState={
          <div
            data-testid="control-breakdown-empty-state"
            className="flex flex-col items-start gap-2 text-sm font-body text-deep-charcoal/80"
          >
            <p>No controls configured for this product.</p>
            <Link
              to="/console/settings"
              data-testid="control-breakdown-empty-cta"
              className="underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Configure compliance controls in Settings
            </Link>
          </div>
        }
        rowKey={(r) => r.control_id}
        ariaLabel="Per-control compliance breakdown"
      />
    </section>
  );
}
