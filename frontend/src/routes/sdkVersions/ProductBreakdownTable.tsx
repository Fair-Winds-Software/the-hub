// Authorized by HUB-1633 (E-FE-10 S4) — Product breakdown table for the
// HUB-1631 SDK versions page. Renders a sortable HUB-1601 DataTable with
// every product reporting the selected SDK plus a status badge (current /
// behind / EOL / stale) computed server-side per HUB-1583 (BE owns the
// stale-threshold lookup from hub_settings.sdk_stale_threshold_days).
//
// Data is sliced from the parent's products fetch. The 4 badge variants
// are distinct in icon + color + text per AC#5 a11y floor — color alone is
// insufficient.
import { useMemo } from 'react';
import { DataTable, type ColumnDef } from '../../components/DataTable';

export type SdkProductStatus = 'current' | 'behind' | 'eol' | 'stale';

export interface ProductBreakdownRow {
  productId: string;
  productName: string;
  currentVersion: string;
  lastReportedAt: string;
  daysBehindLatest: number;
  status: SdkProductStatus;
}

export interface ProductBreakdownTableProps {
  sdkName: string;
  rows: ProductBreakdownRow[];
  loading?: boolean;
  error?: string | null;
}

const STATUS_TEXT: Record<SdkProductStatus, string> = {
  current: 'current',
  behind: 'behind',
  eol: 'end-of-life',
  stale: 'stale',
};

const STATUS_BG_CLASS: Record<SdkProductStatus, string> = {
  current: 'bg-seafoam/15 text-seafoam',
  behind: 'bg-accent-brass/15 text-accent-brass',
  eol: 'bg-ironwake/15 text-ironwake',
  stale: 'bg-deep-charcoal/10 text-deep-charcoal/70',
};

// Failing-first/EOL-first ordering so the most critical statuses surface
// at the top when the column is sorted asc by default.
const STATUS_SORT_ORDER: Record<SdkProductStatus, number> = {
  eol: 0,
  stale: 1,
  behind: 2,
  current: 3,
};

function StatusIcon({
  status,
}: {
  status: SdkProductStatus;
}): React.ReactElement {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    'aria-hidden': true as const,
  };
  switch (status) {
    case 'current':
      return (
        <svg {...common} data-testid={`sdk-status-icon-${status}`}>
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
    case 'behind':
      return (
        <svg {...common} data-testid={`sdk-status-icon-${status}`}>
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
    case 'eol':
      return (
        <svg {...common} data-testid={`sdk-status-icon-${status}`}>
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
    case 'stale':
    default:
      return (
        <svg {...common} data-testid={`sdk-status-icon-${status}`}>
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
            y1="5"
            x2="8"
            y2="8.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <line
            x1="8"
            y1="8.5"
            x2="10.5"
            y2="10"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

function StatusBadge({
  status,
}: {
  status: SdkProductStatus;
}): React.ReactElement {
  return (
    <span
      data-testid={`sdk-status-${status}`}
      aria-label={`Status: ${STATUS_TEXT[status]}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-body ${STATUS_BG_CLASS[status]}`}
    >
      <StatusIcon status={status} />
      <span>{STATUS_TEXT[status]}</span>
    </span>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function ProductBreakdownTable({
  sdkName,
  rows,
  loading = false,
  error = null,
}: ProductBreakdownTableProps): React.ReactElement {
  const columns: ColumnDef<ProductBreakdownRow>[] = useMemo(
    () => [
      {
        key: 'product',
        header: 'Product',
        render: (r) => r.productName,
        sortable: true,
        sortValue: (r) => r.productName.toLowerCase(),
        searchValue: (r) => `${r.productName} ${r.productId}`.toLowerCase(),
      },
      {
        key: 'currentVersion',
        header: 'Current SDK Version',
        render: (r) => r.currentVersion,
        sortable: true,
        sortValue: (r) => r.currentVersion,
      },
      {
        key: 'lastReported',
        header: 'Last Reported',
        render: (r) => formatTimestamp(r.lastReportedAt),
        sortable: true,
        sortValue: (r) => new Date(r.lastReportedAt),
      },
      {
        key: 'daysBehind',
        header: 'Days Behind Latest',
        render: (r) => r.daysBehindLatest,
        sortable: true,
        sortValue: (r) => r.daysBehindLatest,
      },
      {
        key: 'status',
        header: 'Status',
        render: (r) => <StatusBadge status={r.status} />,
        sortable: true,
        sortValue: (r) => STATUS_SORT_ORDER[r.status] ?? 99,
      },
    ],
    [],
  );

  return (
    <section
      aria-labelledby="product-breakdown-section-heading"
      data-testid="sdk-versions-section-products"
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
    >
      <h2
        id="product-breakdown-section-heading"
        className="font-heading text-lg text-primary-navy mb-2"
      >
        Product Breakdown
      </h2>
      <DataTable<ProductBreakdownRow>
        columns={columns}
        rows={rows}
        pageSize={50}
        defaultSort={{ key: 'product', direction: 'asc' }}
        searchableColumns={['product']}
        loading={loading}
        error={error}
        emptyState={
          <div
            data-testid="product-breakdown-empty-state"
            className="text-sm font-body text-deep-charcoal/80"
          >
            No products reporting <strong>{sdkName}</strong>.
          </div>
        }
        rowKey={(r) => r.productId}
        ariaLabel="Per-product SDK version breakdown"
      />
    </section>
  );
}
