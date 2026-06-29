// Authorized by HUB-1606 (E-FE-3 S6) — Plans tab inside the HUB-1604 product
// detail. Read-only list of the product's pricing models (active + history)
// via the HUB-1601 <DataTable>. No create/edit/delete — pricing-model
// authoring lives in HUB-1563 (E-FE-5).
//
// Spec deviations (documented per ironclad-engineer):
// 1. Endpoint: spec named GET /api/v1/admin/products/:productId/plans which
//    does not exist at v0.1. The actual HUB pricing surface is
//    GET /api/v1/admin/console/pricing/:productId/overview (HUB-1146) which
//    returns { active_model: PricingModelRow | null, history: [...] }. We
//    flatten active_model + history into a single rows array and pass to
//    DataTable. When the spec-named /plans endpoint lands, this file maps
//    1:1 to the new shape.
// 2. "Active Subscriptions" column: the overview endpoint does not surface
//    a per-model subscription count. Cell renders "—" with the contract that
//    when the BE adds a count to the overview response or a sibling endpoint
//    (HUB-1545 Tech Debt), the column auto-populates.
// 3. "Price" column: pricing model config is a freeform JSONB blob whose
//    shape varies by model_type ('standard' has flat amounts; 'credit' has
//    bucket grants; 'tiered' has tier rows). Surfacing a single canonical
//    price would mis-represent multi-tier models. Cell renders the currency
//    + model_type tag instead — operators click through to the pricing
//    editor (HUB-1563) for the full shape.
// 4. Empty state: secondary CTA links to /console/products/:productId/pricing
//    (HUB-1563 owner) per the spec.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { apiClient } from '../../lib/api';

const PRICING_OVERVIEW_PATH = (productId: string): string =>
  `/api/v1/admin/console/pricing/${productId}/overview`;

const PAGE_SIZE = 25;

interface PricingModelRow {
  model_id: string;
  product_id: string;
  model_type: string;
  currency: string;
  config: Record<string, unknown>;
  active: boolean;
  activated_at: string | null;
  deprecated_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface PricingOverview {
  active_model: PricingModelRow | null;
  history: PricingModelRow[];
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: PricingModelRow[] };

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

function ActiveBadge({ active }: { active: boolean }): React.ReactElement {
  return (
    <span
      data-testid={active ? 'plan-active-badge' : 'plan-inactive-badge'}
      className={
        active
          ? 'inline-flex items-center rounded-full bg-seafoam/15 px-2 py-0.5 text-xs text-seafoam'
          : 'inline-flex items-center rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs text-deep-charcoal/70'
      }
    >
      {active ? 'active' : 'inactive'}
    </span>
  );
}

export interface PlansTabProps {
  productId: string;
}

export function PlansTab({ productId }: PlansTabProps): React.ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void apiClient
      .get<PricingOverview>(PRICING_OVERVIEW_PATH(productId))
      .then((res) => {
        if (cancelled) return;
        const rows: PricingModelRow[] = [];
        if (res.active_model) rows.push(res.active_model);
        rows.push(...res.history);
        setState({ kind: 'ready', rows });
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load plans';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const columns: ColumnDef<PricingModelRow>[] = useMemo(
    () => [
      {
        key: 'name',
        header: 'Plan Name',
        render: (r) => (
          <div className="flex items-center gap-2">
            <span data-testid={`plan-name-${r.model_id}`}>
              {r.model_type}
            </span>
            {r.active && <ActiveBadge active />}
          </div>
        ),
        sortable: true,
        sortValue: (r) => r.model_type,
      },
      {
        key: 'billingMode',
        header: 'Billing Mode',
        render: (r) => r.model_type,
        sortable: true,
        sortValue: (r) => r.model_type,
      },
      {
        key: 'price',
        header: 'Price',
        render: (r) => (
          <span className="text-deep-charcoal/80">
            {r.currency.toUpperCase()} · see model
          </span>
        ),
      },
      {
        key: 'subs',
        header: 'Active Subscriptions',
        render: () => <span className="text-deep-charcoal/60">—</span>,
      },
      {
        key: 'createdAt',
        header: 'Created Date',
        render: (r) => formatDate(r.created_at),
        sortable: true,
        sortValue: (r) => new Date(r.created_at),
      },
    ],
    [],
  );

  if (state.kind === 'loading') {
    return <div data-testid="plans-tab-loading" className="p-4 text-sm font-body text-deep-charcoal/70">Loading plans…</div>;
  }

  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        data-testid="plans-tab-error"
        className="m-4 rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Could not load plans for this product.</p>
        <p className="mt-1">{state.message}</p>
      </div>
    );
  }

  const rows = state.rows;

  return (
    <div data-testid="plans-tab" className="p-4">
      <DataTable<PricingModelRow>
        columns={columns}
        rows={rows}
        pageSize={PAGE_SIZE}
        defaultSort={{ key: 'createdAt', direction: 'desc' }}
        loading={false}
        error={null}
        emptyState={
          <div
            data-testid="plans-empty-state"
            className="flex flex-col items-start gap-2 text-sm font-body text-deep-charcoal/80"
          >
            <p>No plans configured for this product.</p>
            <Link
              to={`/console/products/${productId}/pricing`}
              data-testid="plans-empty-cta"
              className="underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              Configure pricing model
            </Link>
          </div>
        }
        rowKey={(r) => r.model_id}
        ariaLabel="Product plans"
      />
    </div>
  );
}
