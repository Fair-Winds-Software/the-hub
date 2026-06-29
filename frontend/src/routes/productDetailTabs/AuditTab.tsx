// Authorized by HUB-1607 (E-FE-3 S7) — Audit tab inside HUB-1604 product detail.
// Renders the last 20 audit entries for this product over the HUB-1601
// DataTable. A "See all" CTA at top right deep-links into the HUB-1558 audit
// explorer with productId pre-filtered (cross-Epic landing — paired with the
// HUB-1616 useAuditUrlSync cross-Epic-landing test).
//
// Spec deviations / notes (per ironclad-engineer):
// 1. Endpoint contract: '/api/v1/admin/console/audit-log' (HUB-1697) requires
//    tenant_id on every call (HUB-1704 convention) and accepts snake_case
//    query params (product_id, not productId). We pass tenant_id from the
//    parent's PortfolioProduct.tenantId.
// 2. Row click: spec flagged "expand inline OR detail modal" as a UX
//    decision. At v0.1 we render the full Detail JSON in a popover-less
//    truncated cell; deeper inspection is "See all" -> HUB-1558 explorer
//    which already owns the row drawer (HUB-1615). Avoids re-implementing
//    drawer state inside a tab that can be unmounted by tab switching.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { apiClient } from '../../lib/api';

const AUDIT_LOG_PATH = '/api/v1/admin/console/audit-log';
const PAGE_LIMIT = 20;
const DETAIL_PREVIEW_MAX = 80;

interface AuditRow {
  id: string;
  operator_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  before_value: unknown;
  after_value: unknown;
  notes: string | null;
  tenant_id: string | null;
  product_id: string | null;
  recommendation_id: string | null;
  created_at: string;
}

interface AuditLogResponse {
  data: AuditRow[];
  total: number;
  limit: number;
  offset: number;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: AuditRow[]; total: number };

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
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export interface AuditTabProps {
  productId: string;
  tenantId: string;
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
  },
  {
    key: 'action',
    header: 'Action',
    render: (r) => r.action,
    sortable: true,
    sortValue: (r) => r.action,
  },
  {
    key: 'entityType',
    header: 'Entity Type',
    render: (r) => r.entity_type,
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

export function AuditTab({ productId, tenantId }: AuditTabProps): React.ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const params = new URLSearchParams();
    params.set('tenant_id', tenantId);
    params.set('product_id', productId);
    params.set('limit', String(PAGE_LIMIT));
    void apiClient
      .get<AuditLogResponse>(`${AUDIT_LOG_PATH}?${params.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setState({ kind: 'ready', rows: res.data, total: res.total });
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load audit entries';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [productId, tenantId]);

  const seeAllHref = useMemo(
    () => `/console/audit?product_id=${encodeURIComponent(productId)}`,
    [productId],
  );

  return (
    <div data-testid="audit-tab" className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-body text-sm text-deep-charcoal/70">
          {state.kind === 'ready' && state.rows.length > 0
            ? `Showing the last ${state.rows.length} of ${state.total} entries`
            : 'Most recent activity scoped to this product.'}
        </p>
        <Link
          to={seeAllHref}
          data-testid="audit-tab-see-all"
          className="inline-flex items-center rounded-md border border-primary-navy/20 bg-white px-3 py-1.5 text-sm font-body text-primary-navy shadow-sm hover:bg-primary-navy/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          See all
        </Link>
      </div>
      {state.kind === 'loading' && (
        <div
          data-testid="audit-tab-loading"
          className="text-sm font-body text-deep-charcoal/70"
        >
          Loading audit entries…
        </div>
      )}
      {state.kind === 'error' && (
        <div
          role="alert"
          data-testid="audit-tab-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Could not load audit entries.</p>
          <p className="mt-1">{state.message}</p>
        </div>
      )}
      {state.kind === 'ready' && (
        <DataTable<AuditRow>
          columns={COLUMNS}
          rows={state.rows}
          pageSize={PAGE_LIMIT}
          defaultSort={{ key: 'createdAt', direction: 'desc' }}
          loading={false}
          error={null}
          emptyState={
            <div
              data-testid="audit-tab-empty-state"
              className="text-sm font-body text-deep-charcoal/80"
            >
              No audit entries for this product yet.
            </div>
          }
          rowKey={(r) => r.id}
          ariaLabel="Product audit entries"
        />
      )}
    </div>
  );
}
