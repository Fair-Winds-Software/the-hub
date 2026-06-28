// Authorized by HUB-1614 (E-FE-12 S4) — audit result table. Consumes HUB-1601 <DataTable>
// (the canonical Pass-1 table primitive) and renders the 6 spec columns: Timestamp / Actor /
// Action / Entity Type / Entity ID / Detail. Sortable Timestamp default-desc per AC#9.
//
// Owns three render concerns the parent page doesn't:
// 1. The "Showing N entries" summary line above the table (AC#4).
// 2. The error banner above the table when the API call failed (AC#7).
// 3. The empty-state spec text passed down to DataTable's emptyState slot (AC#6).
//
// Spec deviation (documented):
// - AC#7 "Retry" affordance: AuditFilters owns the fetch lifecycle (HUB-1613), and lifting
//   an imperative re-fetch handle would require refactoring it. v0.1: the error banner
//   text points operators at the existing "Reset filters" button in the sidebar (which
//   already bypasses the debounce and re-issues the call). Same UX outcome without the
//   refactor.
//
// Row click is wired here via the optional onRowClick prop; HUB-1615 (S5) provides the
// side-drawer consumer at the Audit page level.
import { useMemo, type ReactNode } from 'react';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import type { AuditRow } from './AuditFilters';

const PAGE_SIZE = 50;
const DETAIL_PREVIEW_MAX = 80;
const EMPTY_STATE_TEXT =
  'No matching audit entries — try widening your filters.';

export interface AuditResultTableProps {
  rows: AuditRow[] | null;
  total: number;
  loading: boolean;
  error: string | null;
  /** Row click handler — HUB-1615 S5 wires this to the SideDrawer. */
  onRowClick?: (row: AuditRow) => void;
}

function detailPreview(row: AuditRow): string {
  const payload: Record<string, unknown> = {};
  if (row.notes) payload.notes = row.notes;
  if (row.before_value !== null && row.before_value !== undefined)
    payload.before = row.before_value;
  if (row.after_value !== null && row.after_value !== undefined)
    payload.after = row.after_value;
  const str = JSON.stringify(payload);
  if (str.length <= DETAIL_PREVIEW_MAX) return str;
  return `${str.slice(0, DETAIL_PREVIEW_MAX - 1)}…`;
}

function formatTimestamp(iso: string): string {
  // Locale-formatted; jsdom returns a stable POSIX-ish output for tests.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

const COLUMNS: ColumnDef<AuditRow>[] = [
  {
    key: 'createdAt',
    header: 'Timestamp',
    render: (r) => formatTimestamp(r.created_at),
    sortable: true,
    sortValue: (r) => new Date(r.created_at),
  },
  {
    key: 'actor',
    header: 'Actor',
    render: (r) => r.operator_id ?? '—',
    sortable: true,
    sortValue: (r) => r.operator_id ?? '',
    searchValue: (r) => r.operator_id ?? '',
  },
  {
    key: 'action',
    header: 'Action',
    render: (r) => r.action,
    sortable: true,
    sortValue: (r) => r.action,
    searchValue: (r) => r.action,
  },
  {
    key: 'entityType',
    header: 'Entity Type',
    render: (r) => r.entity_type,
    sortable: true,
    sortValue: (r) => r.entity_type,
  },
  {
    key: 'entityId',
    header: 'Entity ID',
    render: (r) => r.entity_id,
  },
  {
    key: 'detail',
    header: 'Detail',
    render: (r) => detailPreview(r),
  },
];

export function AuditResultTable({
  rows,
  total,
  loading,
  error,
  onRowClick,
}: AuditResultTableProps): React.ReactElement {
  // Memoize the array passed to DataTable so it doesn't re-sort/re-paginate identically
  // shaped lists between renders.
  const tableRows = useMemo<AuditRow[]>(() => rows ?? [], [rows]);

  // "Showing N entries" line above the table (AC#4). When rows haven't loaded yet
  // (rows === null and no error), show a neutral status; while loading, defer to
  // DataTable's skeleton.
  let summary: ReactNode;
  if (error) {
    summary = null;
  } else if (loading) {
    summary = <span data-testid="audit-summary-loading">Loading audit entries…</span>;
  } else if (rows === null) {
    summary = <span>Apply filters to view audit entries.</span>;
  } else if (total === 0) {
    summary = <span>No matching entries.</span>;
  } else {
    summary = (
      <span data-testid="audit-summary-count">
        Showing {tableRows.length} of {total} entries
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="audit-result-table">
      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          data-testid="audit-error-banner"
        >
          <p className="font-body font-medium">Could not load audit entries.</p>
          <p className="font-body mt-1">{error}</p>
          <p className="font-body mt-2 text-red-700/80">
            Try clicking <strong>Reset filters</strong> in the sidebar to re-run the
            query, or adjust a filter to trigger a fresh fetch.
          </p>
        </div>
      )}
      <div className="text-sm font-body text-deep-charcoal/80">{summary}</div>
      <DataTable<AuditRow>
        columns={COLUMNS}
        rows={tableRows}
        pageSize={PAGE_SIZE}
        defaultSort={{ key: 'createdAt', direction: 'desc' }}
        loading={loading}
        // Don't double-render the error inside the table — the banner above handles it.
        error={null}
        emptyState={<span>{EMPTY_STATE_TEXT}</span>}
        onRowClick={onRowClick}
        rowKey={(r) => r.id}
        ariaLabel="Audit log entries"
      />
    </div>
  );
}
