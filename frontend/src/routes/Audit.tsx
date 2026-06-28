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
// RBAC: `requiredRole="product_admin"` per HUB-1612 AC#1 — role hierarchy means super_admin
// still reaches the route; product_admin newly granted access. Per-product RBAC scope
// filtering belongs to HUB-1618 (S8) on the BE side.
import { useCallback, useEffect, useState } from 'react';
import { AuditFilters, type AuditRow } from './audit/AuditFilters';
import { AuditResultTable } from './audit/AuditResultTable';

const PAGE_TITLE = 'Audit Log | HUB Console';

export default function Audit(): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const handleResults = useCallback(
    (data: AuditRow[] | null, totalCount: number, errMsg?: string) => {
      setRows(data);
      setTotal(totalCount);
      setError(errMsg ?? null);
    },
    [],
  );

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
        />
      </main>
    </div>
  );
}
