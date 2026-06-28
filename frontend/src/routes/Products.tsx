// Authorized by HUB-1603 (E-FE-3 S3) — /console/products list view. Renders the HUB
// portfolio over the HUB-1601 <DataTable> primitive; ticket counts lazy-load per row
// after the initial table render so Atlassian latency doesn't block first paint
// (NFR §9 LCP < 2.5s + AC-E2 50-row < 500ms).
//
// Spec deviations (documented per ironclad-engineer):
// 1. API path: `/api/v1/admin/portfolio/products` (canonical from HUB-1700) — spec
//    said `/api/v1/admin/products` which is the tenant-scoped registration endpoint,
//    not the portfolio aggregator. Portfolio surfaces MRR + lastActiveAt + status
//    in a single call, which is what the spec actually wants.
// 2. "Version" column: the portfolio aggregator does NOT surface an SDK version field
//    (products schema doesn't carry one at v0.1). Column renders "—" with the
//    contract that S5 / E-BE-1 surfaces the field when it exists. Not blocking the
//    list view per the §1 Overview: "version" alongside other product metadata.
// 3. Jira ticket counts: `productKey` is the product NAME (Jira project key — "Synapz",
//    "HUB", etc.) per jiraIntegrationService.ts (HUB-1593). We pass productName as the
//    query value, not the products.id UUID.
// 4. Empty state: no add-product affordance per HUB-1557 §2 OOS-Won't-Do (Decision Log).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataTable, type ColumnDef } from '../components/DataTable';
import { apiClient } from '../lib/api';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const JIRA_TICKETS_PATH = '/api/v1/admin/integrations/jira/tickets';
const PAGE_TITLE = 'Products | HUB Console';
const PAGE_SIZE = 50;

export interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
  tenantName: string;
  status: string;
  mrrCents: number;
  createdAt: string;
  lastActiveAt: string | null;
}

interface PortfolioResponse {
  data: PortfolioProduct[];
  total: number;
}

type JiraTicketsResponse =
  | { available: true; openCRs: number; openBugs: number; lastSyncedAt: string }
  | { available: false; reason: string };

type TicketState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; openCRs: number; openBugs: number };

function formatMrr(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '$0';
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(dollars);
}

function formatLastActive(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

export default function Products(): React.ReactElement {
  const navigate = useNavigate();
  const [products, setProducts] = useState<PortfolioProduct[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Record<string, TicketState>>({});

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const loadProducts = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<PortfolioResponse>(
        `${PORTFOLIO_PATH}?limit=${PAGE_SIZE}`,
      );
      setProducts(res.data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load products';
      setError(message);
      setProducts(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  // Lazy-load ticket counts AFTER the table is in the DOM with rows. Bounded to the
  // current page (max 50 calls), parallel via Promise.all. Per-row degraded responses
  // (200 with available:false) render as "—" rather than blocking the row.
  useEffect(() => {
    if (!products || products.length === 0) return;
    const initial: Record<string, TicketState> = {};
    for (const p of products) initial[p.productId] = { kind: 'loading' };
    setTickets(initial);

    let cancelled = false;
    void Promise.all(
      products.map(async (p) => {
        try {
          const res = await apiClient.get<JiraTicketsResponse>(
            `${JIRA_TICKETS_PATH}?productId=${encodeURIComponent(p.productName)}`,
          );
          if (cancelled) return;
          setTickets((prev) => ({
            ...prev,
            [p.productId]: res.available
              ? { kind: 'ready', openCRs: res.openCRs, openBugs: res.openBugs }
              : { kind: 'unavailable' },
          }));
        } catch {
          if (cancelled) return;
          setTickets((prev) => ({ ...prev, [p.productId]: { kind: 'unavailable' } }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [products]);

  const renderTicketCounts = useCallback(
    (row: PortfolioProduct): React.ReactNode => {
      const t = tickets[row.productId];
      if (!t || t.kind === 'loading') {
        return (
          <span
            data-testid={`ticket-loading-${row.productId}`}
            className="text-deep-charcoal/60"
          >
            checking…
          </span>
        );
      }
      if (t.kind === 'unavailable') {
        return (
          <span
            data-testid={`ticket-unavailable-${row.productId}`}
            className="text-deep-charcoal/60"
          >
            —
          </span>
        );
      }
      return (
        <span data-testid={`ticket-ready-${row.productId}`}>
          {t.openCRs} CR · {t.openBugs} bug
        </span>
      );
    },
    [tickets],
  );

  const columns: ColumnDef<PortfolioProduct>[] = useMemo(
    () => [
      {
        key: 'name',
        header: 'Name',
        render: (r) => r.productName,
        sortable: true,
        sortValue: (r) => r.productName.toLowerCase(),
        searchValue: (r) =>
          `${r.productName} ${r.productId}`.toLowerCase(),
      },
      {
        key: 'status',
        header: 'Status',
        render: (r) => r.status,
        sortable: true,
        sortValue: (r) => r.status,
      },
      {
        key: 'version',
        header: 'Version',
        // Deviation #2: products schema doesn't surface SDK version at v0.1.
        render: () => <span className="text-deep-charcoal/60">—</span>,
      },
      {
        key: 'mrr',
        header: 'MRR',
        render: (r) => formatMrr(r.mrrCents),
        sortable: true,
        sortValue: (r) => r.mrrCents,
      },
      {
        key: 'lastActive',
        header: 'Last Active',
        render: (r) => formatLastActive(r.lastActiveAt),
        sortable: true,
        sortValue: (r) =>
          r.lastActiveAt ? new Date(r.lastActiveAt) : new Date(0),
      },
      {
        key: 'tickets',
        header: 'Ticket Counts',
        render: renderTicketCounts,
      },
    ],
    [renderTicketCounts],
  );

  const rows = useMemo<PortfolioProduct[]>(() => products ?? [], [products]);

  const handleRowClick = useCallback(
    (row: PortfolioProduct) => {
      navigate(`/console/products/${row.productId}`);
    },
    [navigate],
  );

  return (
    <div id="main-content" data-testid="products-page" className="flex flex-col gap-4">
      <h1 className="font-heading text-2xl text-primary-navy">Products</h1>
      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
          data-testid="products-error-banner"
        >
          <p className="font-medium">Could not load products.</p>
          <p className="mt-1">{error}</p>
          <button
            type="button"
            onClick={() => void loadProducts()}
            className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Retry
          </button>
        </div>
      )}
      <DataTable<PortfolioProduct>
        columns={columns}
        rows={rows}
        pageSize={PAGE_SIZE}
        defaultSort={{ key: 'name', direction: 'asc' }}
        searchableColumns={['name']}
        loading={loading}
        error={null}
        emptyState={
          <div className="text-sm font-body text-deep-charcoal/80">
            No products yet — products will appear here once they&apos;re registered
            with HUB. Contact a super_admin if you expect to see products and
            don&apos;t.
          </div>
        }
        onRowClick={handleRowClick}
        rowKey={(r) => r.productId}
        ariaLabel="Products list"
      />
    </div>
  );
}
