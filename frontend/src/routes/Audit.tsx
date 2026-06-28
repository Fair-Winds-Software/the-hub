// Authorized by HUB-1612 (E-FE-12 S2) — /console/audit page scaffold + 2-col layout.
// Real route replacing HUB-1578's AuditStub per D-HUB-SCOPE-027 supersession pattern.
//
// Authorized by HUB-1613 (E-FE-12 S3) — wires AuditFilters into the sidebar slot; manages
// loading + result + error state at the page level so S4 (HUB-1614) result table can read
// these directly when it lands.
//
// Authorized by HUB-1614 (E-FE-12 S4) — main slot now renders AuditResultTable (consumes
// HUB-1601 DataTable); replaces the v0.1 scaffolding preview.
//
// Authorized by HUB-1615 (E-FE-12 S5) — row click opens AuditRowDrawer (HUB-1611
// <SideDrawer>); page owns the selectedRow state.
//
// Authorized by HUB-1616 (E-FE-12 S6) — URL `eventId` deep-link opens the drawer for a
// specific row. Row click writes ?eventId=<id> (replace:true); close removes the param.
// AuditFilters owns the rest of the URL filter sync via useAuditUrlSync.
//
// RBAC: `requiredRole="product_admin"` per HUB-1612 AC#1 — role hierarchy means super_admin
// still reaches the route; product_admin newly granted access. Per-product RBAC scope
// filtering belongs to HUB-1618 (S8) on the BE side.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuditFilters, type AuditRow } from './audit/AuditFilters';
import { AuditResultTable } from './audit/AuditResultTable';
import { AuditRowDrawer } from './audit/AuditRowDrawer';

const PAGE_TITLE = 'Audit Log | HUB Console';

export default function Audit(): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // HUB-1615: row selected for the detail drawer. Reset to null when filter results
  // change so the drawer doesn't outlive its referenced row across re-fetches.
  const [selectedRow, setSelectedRow] = useState<AuditRow | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const eventId = searchParams.get('eventId');

  const handleResults = useCallback(
    (data: AuditRow[] | null, totalCount: number, errMsg?: string) => {
      setRows(data);
      setTotal(totalCount);
      setError(errMsg ?? null);
      // HUB-1615: close any open drawer when results change — the referenced row may no
      // longer exist in the new result set.
      setSelectedRow(null);
    },
    [],
  );

  const handleRowClick = useCallback(
    (row: AuditRow) => {
      setSelectedRow(row);
      // HUB-1616: mirror the open drawer into the URL so the link is shareable.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('eventId', row.id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleDrawerClose = useCallback(() => {
    setSelectedRow(null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('eventId');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // HUB-1616: when the URL has ?eventId=<id> AND the matching row is in our loaded
  // results, pre-open the drawer with it. Spec deviation: if eventId is in the URL
  // but not in the current result page, we leave the drawer closed (the row may be
  // on a different page or outside the current filter set). The "Open in new tab"
  // permalink from HUB-1615 still resolves once the row loads.
  useEffect(() => {
    if (!eventId || rows === null) return;
    const match = rows.find((r) => r.id === eventId);
    if (match && match !== selectedRow) {
      setSelectedRow(match);
    }
  }, [eventId, rows, selectedRow]);

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-full">
      <aside
        aria-label="Audit filters"
        data-testid="audit-filter-sidebar"
        className="w-full lg:w-[280px] lg:flex-shrink-0"
      >
        <AuditFilters onResults={handleResults} onLoadingChange={setLoading} />
      </aside>
      <main id="main-content" data-testid="audit-main" className="flex-1 min-w-0">
        <h1 className="font-heading text-2xl text-primary-navy mb-4">Audit Log</h1>
        <AuditResultTable
          rows={rows}
          total={total}
          loading={loading}
          error={error}
          onRowClick={handleRowClick}
        />
      </main>
      <AuditRowDrawer row={selectedRow} onClose={handleDrawerClose} />
    </div>
  );
}
