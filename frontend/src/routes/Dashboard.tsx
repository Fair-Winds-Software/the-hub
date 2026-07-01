// Authorized by HUB-1644 (E-FE-2 S1) — Dashboard route shell. This is the
// canonical post-login landing per HUB-1546 §7 step 2 / HUB-1555 FR-004; the
// route is registered by App.tsx with the same product_admin guard that the
// prior DashboardStub used. The shell owns only the layout container + three
// named widget regions wrapped in `<section aria-label>` landmarks; the
// regions are populated by:
//
//   - Portfolio summary  (aria-label="Portfolio summary")   → S2 (HUB-1645)
//   - Portfolio products (aria-label="Portfolio products")  → S3 (HUB-1646)
//   - Dashboard sidebar  (aria-label="Dashboard sidebar")   → S5 (HUB-1648)
//
// Data fetching lives entirely inside the child widgets per FR-014 / S7 —
// the shell must not fetch anything of its own.
// Authorized by HUB-1645 (E-FE-2 S2) — portfolio-summary region now hosts
// the PortfolioSummaryWidget (MetricTile row + losing-money banner).
// Authorized by HUB-1646 (E-FE-2 S3) — product-grid region now hosts the
// ProductGridWidget (3-column responsive product cards, keyboard-navigable
// links to /console/products/:productId).
// Authorized by HUB-1648 (E-FE-2 S5) — sidebar region now hosts the
// DashboardSidebar (QuickActions row + RecentActivityFeed).
//
// Heading structure: h1 = page title ("Dashboard"), then each region gets a
// visually-hidden h2 keyed off the region's aria-label so screen readers
// can navigate section-by-section. Widget children (added in S2/S3/S5) can
// use h3+ inside their region without breaking heading order.
import { PortfolioSummaryWidget } from './dashboard/PortfolioSummaryWidget';
import { ProductGridWidget } from './dashboard/ProductGridWidget';
import { DashboardSidebar } from './dashboard/DashboardSidebar';

const PAGE_TITLE = 'Dashboard | HUB Console';

export default function Dashboard(): React.ReactElement {
  // Match the pattern used by the other console routes — set the tab title
  // on mount, restore on unmount so subsequent routes get their own title.
  if (typeof document !== 'undefined' && document.title !== PAGE_TITLE) {
    document.title = PAGE_TITLE;
  }

  return (
    <div
      id="main-content"
      data-testid="dashboard-page"
      className="flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1
          data-testid="dashboard-heading"
          className="font-heading text-2xl text-primary-navy"
        >
          Dashboard
        </h1>
        <p className="font-body text-sm text-deep-charcoal/70">
          Portfolio overview — MRR, per-product status, and recent activity.
        </p>
      </header>

      <section
        aria-labelledby="dashboard-region-portfolio-summary-heading"
        data-testid="dashboard-region-portfolio-summary"
      >
        <h2
          id="dashboard-region-portfolio-summary-heading"
          className="sr-only"
        >
          Portfolio summary
        </h2>
        <PortfolioSummaryWidget />
      </section>

      <section
        aria-labelledby="dashboard-region-product-grid-heading"
        data-testid="dashboard-region-product-grid"
      >
        <h2
          id="dashboard-region-product-grid-heading"
          className="sr-only"
        >
          Portfolio products
        </h2>
        <ProductGridWidget />
      </section>

      <section
        aria-labelledby="dashboard-region-sidebar-heading"
        data-testid="dashboard-region-sidebar"
      >
        <h2 id="dashboard-region-sidebar-heading" className="sr-only">
          Dashboard sidebar
        </h2>
        <DashboardSidebar />
      </section>
    </div>
  );
}
