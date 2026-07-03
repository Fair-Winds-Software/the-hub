// Authorized by HUB-1688 (E-FE-13 S3) — Failed Payments filter sidebar
// (status multi-select + product dropdown + date range from/to) +
// counts panel. Controlled surface; parent owns URL state via
// useSearchParams — same pattern as HUB-1682's customer-health filters.
//
// Product dropdown sources from /api/v1/admin/portfolio/products — same
// lookup SystemHealth + CustomerHealth use. product_admin gets a
// server-scoped list; no client-side layered scope check needed.

import { statusLabel } from './failed-payments-formatters';
import type { FailedPaymentStatus } from '../FailedPayments';

const STATUSES: FailedPaymentStatus[] = [
  'pending_retry',
  'exhausted',
  'recovered',
  'overridden',
];

export interface FailedPaymentsFilterValue {
  statuses: FailedPaymentStatus[];
  productId: string | null;
  from: string | null;
  to: string | null;
}

export interface FailedPaymentsProduct {
  productId: string;
  productName: string;
}

export interface StatusCounts {
  pending_retry: number;
  exhausted: number;
  recovered: number;
  overridden: number;
}

interface FailedPaymentsFiltersProps {
  value: FailedPaymentsFilterValue;
  onChange: (next: FailedPaymentsFilterValue) => void;
  onReset: () => void;
  products: FailedPaymentsProduct[];
  counts: StatusCounts;
}

function CountsPanel({ counts }: { counts: StatusCounts }): React.ReactElement {
  const items: Array<{ status: FailedPaymentStatus; count: number }> = [
    { status: 'pending_retry', count: counts.pending_retry },
    { status: 'exhausted', count: counts.exhausted },
    { status: 'recovered', count: counts.recovered },
    { status: 'overridden', count: counts.overridden },
  ];
  return (
    <ul
      data-testid="failed-payments-counts"
      className="flex flex-col gap-1 rounded border border-deep-charcoal/15 bg-white p-2 text-xs font-body"
    >
      {items.map((item) => (
        <li
          key={item.status}
          data-testid={`failed-payments-count-${item.status}`}
          className="flex items-center justify-between"
        >
          <span className="text-deep-charcoal/70">
            {statusLabel(item.status)}
          </span>
          <span className="font-mono text-deep-charcoal">{item.count}</span>
        </li>
      ))}
    </ul>
  );
}

export function FailedPaymentsFilters({
  value,
  onChange,
  onReset,
  products,
  counts,
}: FailedPaymentsFiltersProps): React.ReactElement {
  const toggleStatus = (s: FailedPaymentStatus): void => {
    const next = value.statuses.includes(s)
      ? value.statuses.filter((x) => x !== s)
      : [...value.statuses, s];
    onChange({ ...value, statuses: next });
  };
  return (
    <aside
      data-testid="failed-payments-filters"
      aria-label="Filter failed payments"
      className="flex w-full flex-col gap-4 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 md:w-60"
    >
      <div className="flex flex-col gap-2">
        <p className="text-xs font-body text-deep-charcoal/70">
          Counts (30-day window)
        </p>
        <CountsPanel counts={counts} />
      </div>

      <button
        type="button"
        data-testid="failed-payments-reset"
        onClick={onReset}
        className="rounded border border-deep-charcoal/20 bg-transparent px-3 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        Reset filters
      </button>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-body text-deep-charcoal/70">
          Status
        </legend>
        {STATUSES.map((s) => (
          <label
            key={s}
            className="inline-flex items-center gap-2 text-sm font-body text-deep-charcoal"
          >
            <input
              type="checkbox"
              data-testid={`failed-payments-filter-status-${s}`}
              checked={value.statuses.includes(s)}
              onChange={() => toggleStatus(s)}
              className="rounded focus:ring-2 focus:ring-accent-brass"
            />
            {statusLabel(s)}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="failed-payments-filter-product"
          className="text-xs font-body text-deep-charcoal/70"
        >
          Product
        </label>
        <select
          id="failed-payments-filter-product"
          data-testid="failed-payments-filter-product"
          value={value.productId ?? ''}
          onChange={(e) =>
            onChange({ ...value, productId: e.target.value || null })
          }
          className="rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          <option value="">All products</option>
          {products.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.productName}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="failed-payments-filter-from"
          className="text-xs font-body text-deep-charcoal/70"
        >
          From
        </label>
        <input
          id="failed-payments-filter-from"
          data-testid="failed-payments-filter-from"
          type="date"
          value={value.from ?? ''}
          onChange={(e) =>
            onChange({ ...value, from: e.target.value || null })
          }
          className="rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="failed-payments-filter-to"
          className="text-xs font-body text-deep-charcoal/70"
        >
          To
        </label>
        <input
          id="failed-payments-filter-to"
          data-testid="failed-payments-filter-to"
          type="date"
          value={value.to ?? ''}
          onChange={(e) =>
            onChange({ ...value, to: e.target.value || null })
          }
          className="rounded border border-deep-charcoal/20 bg-white px-2 py-1 text-sm font-body focus:outline-none focus:ring-2 focus:ring-accent-brass"
        />
      </div>
    </aside>
  );
}
