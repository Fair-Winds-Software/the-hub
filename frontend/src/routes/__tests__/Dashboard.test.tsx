// Authorized by HUB-1644 (E-FE-2 S1) — Dashboard route shell smoke test.
// Covers: three named widget regions rendered as <section aria-labelledby>
// landmarks with visually-hidden h2 headings; a per-region placeholder
// stands in until S2/S3/S5 land; heading order h1 → h2 is preserved; axe-
// core scan passes. Route wiring at App.tsx (product_admin guard + real
// Dashboard swapped in for the prior DashboardStub) is exercised by the
// existing Login.test.tsx + shell tests.
// Authorized by HUB-1645 (E-FE-2 S2) — portfolio-summary region asserts
// the PortfolioSummaryWidget mounts (rather than the S1 placeholder).
// Authorized by HUB-1646 (E-FE-2 S3) — product-grid region asserts the
// ProductGridWidget mounts (rather than the S1 placeholder).
// Authorized by HUB-1648 (E-FE-2 S5) — sidebar region asserts the
// DashboardSidebar (QuickActions + RecentActivityFeed) mounts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from '../Dashboard';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/bi/portfolio/summary')) {
      return Promise.resolve({
        as_of: new Date().toISOString(),
        mrr_cents: null,
        arr_cents: null,
        arpa_cents: null,
        clv_cents: null,
        revenue_growth_pct: null,
        active_customers: null,
        daily_active_users: null,
        churn_rate: null,
        per_product: [],
      });
    }
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [], total: 0 });
    }
    if (path.startsWith('/api/v1/admin/console/audit-log')) {
      return Promise.resolve({ data: [], total: 0 });
    }
    return Promise.reject(new Error('unavailable'));
  });
});

afterEach(() => {
  cleanup();
});

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/console/dashboard']}>
      <Routes>
        <Route path="/console/dashboard" element={<Dashboard />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Dashboard shell (HUB-1644)', () => {
  describe('AC#1 — three named widget regions with landmarks', () => {
    it('renders the dashboard page + heading', () => {
      renderDashboard();
      expect(screen.getByTestId('dashboard-page')).toBeInTheDocument();
      expect(
        screen.getByTestId('dashboard-heading').textContent,
      ).toMatch(/dashboard/i);
    });

    it('renders three <section> regions keyed by aria-labelledby (BI + product grid + sidebar)', () => {
      renderDashboard();
      const bi = screen.getByTestId('dashboard-region-bi');
      const productGrid = screen.getByTestId(
        'dashboard-region-product-grid',
      );
      const sidebar = screen.getByTestId('dashboard-region-sidebar');
      expect(bi.tagName).toBe('SECTION');
      expect(productGrid.tagName).toBe('SECTION');
      expect(sidebar.tagName).toBe('SECTION');
      expect(bi.getAttribute('aria-labelledby')).toBeTruthy();
      expect(productGrid.getAttribute('aria-labelledby')).toBeTruthy();
      expect(sidebar.getAttribute('aria-labelledby')).toBeTruthy();
    });

    it('regions host their real widgets (BI + product grid + sidebar)', async () => {
      renderDashboard();
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget-empty'),
        ).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('dashboard-quick-actions'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('AC#1 — heading order h1 → h2 (no skipped levels)', () => {
    it('renders exactly one h1 and three h2 section headings', () => {
      renderDashboard();
      const headings = screen.getAllByRole('heading', { hidden: true });
      const levels = headings.map(
        (h) => h.tagName.toLowerCase(),
      );
      expect(levels.filter((l) => l === 'h1').length).toBe(1);
      // BI region + product grid + sidebar = 3 h2 landmarks.
      expect(levels.filter((l) => l === 'h2').length).toBe(3);
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan of the S1 shell', async () => {
      const { container } = renderDashboard();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
