// Authorized by HUB-1601 — canonical DataTable pattern for the HUB Operator Console.
// Generic typed component with client-side search + sort + pagination + empty/loading/error
// states + optional row click. Inherits Tailwind tokens from HUB-1571.
//
// Cross-Epic primitive: built ahead of its parent Epic (HUB-1557 E-FE-3) to unblock
// HUB-1614 (E-FE-12 S4 audit result table). Downstream consumers per the story spec:
// HUB-1558 audit, HUB-1560 SDK dist, HUB-1561 advisor list, HUB-1564 settings, HUB-1565
// pricing scenario, HUB-1567 customer health, HUB-1568 failed payments.
//
// Out of scope at v0.1: server-side pagination (controlled variant); virtualization for
// >1000-row tables (flag for downstream Epic if encountered). Search is in-memory
// substring; sort is in-memory stable.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

const DEFAULT_PAGE_SIZE = 50;
const SKELETON_ROW_COUNT = 5;

export interface ColumnDef<T> {
  /** Unique column id (used for sort tracking + React keys). */
  key: string;
  /** Header label rendered in <th>. */
  header: string;
  /** Cell renderer for a given row. */
  render: (row: T) => ReactNode;
  /** When true, header becomes a clickable sort toggle with arrow indicator. */
  sortable?: boolean;
  /**
   * Value extracted from a row for sort comparison. Required if `sortable=true`.
   * Defaults to undefined; without this, sort is no-op even if header is clicked.
   */
  sortValue?: (row: T) => string | number | Date;
  /**
   * Value extracted from a row for substring search match. When omitted, the row
   * contributes the render output's string form (best-effort).
   */
  searchValue?: (row: T) => string;
  /** Optional Tailwind width class (e.g., 'w-32'). */
  className?: string;
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  /** Rows per page; defaults to 50. */
  pageSize?: number;
  /** Initial sort applied on mount. */
  defaultSort?: { key: string; direction: 'asc' | 'desc' };
  /** Column keys eligible for substring search; empty/omitted disables the search input. */
  searchableColumns?: string[];
  loading?: boolean;
  error?: string | null;
  /** Custom empty-state node; defaults to "No matching entries." */
  emptyState?: ReactNode;
  /** When provided, rows become keyboard-activatable (Enter/Space) + clickable. */
  onRowClick?: (row: T) => void;
  /** Unique row id extractor; falls back to row index (less stable). */
  rowKey?: (row: T) => string;
  /** aria-label for the <table>; defaults to "Data table". */
  ariaLabel?: string;
}

type SortDirection = 'asc' | 'desc' | null;

function compareSortValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // Coerce to string for everything else (handles strings, booleans, etc.).
  return String(a).localeCompare(String(b));
}

export function DataTable<T>({
  columns,
  rows,
  pageSize = DEFAULT_PAGE_SIZE,
  defaultSort,
  searchableColumns,
  loading = false,
  error = null,
  emptyState,
  onRowClick,
  rowKey,
  ariaLabel = 'Data table',
}: DataTableProps<T>): React.ReactElement {
  const searchInputId = useId();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(
    defaultSort?.key ?? null,
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    defaultSort?.direction ?? null,
  );
  const [pageIndex, setPageIndex] = useState(0);

  const searchEnabled =
    Array.isArray(searchableColumns) && searchableColumns.length > 0;

  // ── Derived: filtered → sorted → paginated ────────────────────────────────
  const filteredRows = useMemo(() => {
    if (!searchEnabled || searchQuery.trim() === '') return rows;
    const needle = searchQuery.trim().toLowerCase();
    const searchCols = columns.filter((c) => searchableColumns!.includes(c.key));
    return rows.filter((row) =>
      searchCols.some((col) => {
        const v = col.searchValue?.(row);
        if (v === undefined) return false;
        return v.toLowerCase().includes(needle);
      }),
    );
  }, [rows, searchQuery, searchableColumns, columns, searchEnabled]);

  const sortedRows = useMemo(() => {
    if (sortColumn === null || sortDirection === null) return filteredRows;
    const col = columns.find((c) => c.key === sortColumn);
    if (!col || !col.sortValue) return filteredRows;
    // Stable sort via index tagging.
    const withIndex = filteredRows.map((row, idx) => ({ row, idx }));
    withIndex.sort((a, b) => {
      const va = col.sortValue!(a.row);
      const vb = col.sortValue!(b.row);
      const cmp = compareSortValues(va, vb);
      if (cmp !== 0) return sortDirection === 'asc' ? cmp : -cmp;
      return a.idx - b.idx;
    });
    return withIndex.map((wi) => wi.row);
  }, [filteredRows, sortColumn, sortDirection, columns]);

  const totalCount = sortedRows.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));

  // Clamp pageIndex when filter/sort/rows change reduces the page count.
  useEffect(() => {
    if (pageIndex > pageCount - 1) setPageIndex(0);
  }, [pageIndex, pageCount]);

  const pageRows = useMemo(() => {
    const start = pageIndex * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, pageIndex, pageSize]);

  // ── Sort header click handler ──────────────────────────────────────────────
  const onSortClick = useCallback((colKey: string) => {
    setSortColumn((curCol) => {
      if (curCol !== colKey) {
        // New column → ascending
        setSortDirection('asc');
        return colKey;
      }
      // Same column → cycle asc → desc → none
      setSortDirection((curDir) => {
        if (curDir === 'asc') return 'desc';
        if (curDir === 'desc') return null;
        return 'asc';
      });
      return colKey;
    });
  }, []);

  const ariaSortFor = (colKey: string): 'ascending' | 'descending' | 'none' => {
    if (sortColumn !== colKey || sortDirection === null) return 'none';
    return sortDirection === 'asc' ? 'ascending' : 'descending';
  };

  const handleRowKeyDown = useCallback(
    (row: T) => (event: KeyboardEvent<HTMLTableRowElement>) => {
      if (!onRowClick) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onRowClick(row);
      }
    },
    [onRowClick],
  );

  const startRow = totalCount === 0 ? 0 : pageIndex * pageSize + 1;
  const endRow = Math.min(totalCount, (pageIndex + 1) * pageSize);

  return (
    <div className="flex flex-col gap-3" data-testid="data-table-root">
      {searchEnabled && (
        <div className="flex items-center gap-2">
          <label htmlFor={searchInputId} className="sr-only">
            Search {ariaLabel}
          </label>
          <input
            id={searchInputId}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search…"
            aria-label={`Search ${ariaLabel}`}
            className="w-full max-w-sm rounded border border-mist bg-sailcloth p-2 text-sm font-body text-deep-charcoal focus:outline-none focus:ring-2 focus:ring-primary-brass"
          />
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-mist bg-sailcloth">
        <table aria-label={ariaLabel} className="w-full border-collapse text-sm">
          <thead className="bg-mist/30">
            <tr>
              {columns.map((col) => {
                const sortable = col.sortable && !!col.sortValue;
                const ariaSort = sortable ? ariaSortFor(col.key) : undefined;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={[
                      'border-b border-mist px-3 py-2 text-left font-heading text-primary-navy',
                      col.className ?? '',
                    ].join(' ')}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => onSortClick(col.key)}
                        className="inline-flex items-center gap-1 font-heading text-primary-navy focus:outline-none focus:ring-2 focus:ring-primary-brass"
                      >
                        <span>{col.header}</span>
                        {/* Visual indicator: ▲ for asc, ▼ for desc, faded ↕ otherwise */}
                        <span aria-hidden="true" className="text-xs">
                          {sortColumn === col.key && sortDirection === 'asc'
                            ? '▲'
                            : sortColumn === col.key && sortDirection === 'desc'
                              ? '▼'
                              : '↕'}
                        </span>
                      </button>
                    ) : (
                      <span>{col.header}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {error !== null ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-4">
                  <div role="alert" className="text-red-700">
                    {error}
                  </div>
                </td>
              </tr>
            ) : loading ? (
              Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                <tr key={`skeleton-${i}`} data-testid="data-table-skeleton-row">
                  {columns.map((col) => (
                    <td key={col.key} className="border-b border-mist px-3 py-2">
                      <div className="h-3 w-full max-w-[12rem] animate-pulse rounded bg-mist motion-reduce:animate-none" />
                    </td>
                  ))}
                </tr>
              ))
            ) : pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-6 text-center text-deep-charcoal/60"
                >
                  {emptyState ?? 'No matching entries.'}
                </td>
              </tr>
            ) : (
              pageRows.map((row, rowIdxInPage) => {
                const key = rowKey
                  ? rowKey(row)
                  : `row-${pageIndex}-${rowIdxInPage}`;
                const clickable = !!onRowClick;
                return (
                  <tr
                    key={key}
                    data-testid="data-table-row"
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => onRowClick!(row) : undefined}
                    onKeyDown={clickable ? handleRowKeyDown(row) : undefined}
                    className={[
                      'border-b border-mist last:border-b-0',
                      clickable
                        ? 'cursor-pointer hover:bg-mist/40 focus:bg-mist/40 focus:outline-none focus:ring-2 focus:ring-primary-brass'
                        : '',
                    ].join(' ')}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className="border-b border-mist px-3 py-2 font-body text-deep-charcoal"
                      >
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {!loading && error === null && totalCount > 0 && (
        <div
          className="flex items-center justify-between text-sm font-body text-deep-charcoal"
          data-testid="data-table-pagination"
        >
          <span>
            Showing {startRow}–{endRow} of {totalCount} entries
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
              disabled={pageIndex === 0}
              aria-label="Previous page"
              className="rounded border border-mist bg-sailcloth px-3 py-1 hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary-brass"
            >
              Prev
            </button>
            <span aria-live="polite">
              Page {pageIndex + 1} of {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))}
              disabled={pageIndex >= pageCount - 1}
              aria-label="Next page"
              className="rounded border border-mist bg-sailcloth px-3 py-1 hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary-brass"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
