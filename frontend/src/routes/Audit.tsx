// Authorized by HUB-1612 (E-FE-12 S2) — /console/audit page scaffold + 2-col layout.
// Real route replacing HUB-1578's AuditStub per D-HUB-SCOPE-027 supersession pattern.
//
// Scope at S2: structural shell only — sidebar landmark + main landmark + document.title +
// responsive collapse below 1024px. Filter controls (HUB-1613 S3) and result table
// (HUB-1614 S4) fill the placeholder slots in subsequent stories.
//
// Spec interpretation note (AC#6/7 loading + error state): no data fetch happens at S2 —
// S3 owns filter submission, S4 owns result fetch. The "skeleton matching 2-col layout while
// initial mount" is satisfied by the structural placeholder content rendering immediately —
// it IS the v0.1 page until S3/S4 land. The page-level error state per
// `error-message-guidelines` will be added when API calls land at S3.
//
// RBAC: `requiredRole="product_admin"` per AC#1 — role hierarchy means super_admin still
// reaches the route; product_admin newly granted access (broadens prior super_admin-only
// wiring in App.tsx). RBAC scope filtering (per-product) belongs to S8 (HUB-1618).
import { useEffect } from 'react';

const PAGE_TITLE = 'Audit Log | HUB Console';

export default function Audit(): React.ReactElement {
  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-full">
      <aside
        aria-label="Audit filters"
        data-testid="audit-filter-sidebar"
        className="w-full lg:w-[280px] lg:flex-shrink-0"
      >
        {/* Placeholder slot — filter controls land here (HUB-1613 S3). */}
        <div className="rounded-md border border-mist bg-sailcloth p-4 text-deep-charcoal/60 font-body">
          <h2 className="font-heading text-lg text-primary-navy mb-2">Filters</h2>
          <p className="text-sm">Filter controls land in S3 (HUB-1613).</p>
        </div>
      </aside>
      <main
        id="main-content"
        data-testid="audit-main"
        className="flex-1 min-w-0"
      >
        <h1 className="font-heading text-2xl text-primary-navy mb-4">Audit Log</h1>
        {/* Placeholder slot — result table lands here (HUB-1614 S4). */}
        <div className="rounded-md border border-mist bg-sailcloth p-4 text-deep-charcoal/60 font-body">
          <p>Result table lands in S4 (HUB-1614).</p>
        </div>
      </main>
    </div>
  );
}
