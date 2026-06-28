// Authorized by HUB-1612 (E-FE-12 S2) — /console/audit page scaffold + 2-col layout.
// Real route replacing HUB-1578's AuditStub per D-HUB-SCOPE-027 supersession pattern.
//
// Authorized by HUB-1613 (E-FE-12 S3) — wires AuditFilters into the sidebar slot; manages
// loading + result + error state at the page level so S4 (HUB-1614) result table can read
// these directly when it lands. The "result table" main slot still shows a v0.1 scaffolding
// preview (row count + error banner) until HUB-1614 fills it with the real DataTable render.
//
// RBAC: `requiredRole="product_admin"` per HUB-1612 AC#1 — role hierarchy means super_admin
// still reaches the route; product_admin newly granted access. Per-product RBAC scope
// filtering belongs to HUB-1618 (S8) on the BE side.
import { useCallback, useEffect, useState } from 'react';
import { AuditFilters, type AuditRow } from './audit/AuditFilters';

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
        {/* S3 scaffolding preview — HUB-1614 S4 swaps this for the real DataTable render. */}
        <div className="rounded-md border border-mist bg-sailcloth p-4 font-body text-deep-charcoal/80">
          {loading ? (
            <p data-testid="audit-loading">Loading audit entries…</p>
          ) : error ? (
            <p data-testid="audit-error" role="alert" className="text-red-700">
              {error}
            </p>
          ) : rows === null ? (
            <p>Result table lands in S4 (HUB-1614).</p>
          ) : (
            <p data-testid="audit-result-count">
              Showing {rows.length} of {total} entries.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
