// Authorized by HUB-1644 (E-FE-2 S1) — Dashboard route shell smoke test.
// Covers: three named widget regions rendered as <section aria-labelledby>
// landmarks with visually-hidden h2 headings; a per-region placeholder
// stands in until S2/S3/S5 land; heading order h1 → h2 is preserved; axe-
// core scan passes. Route wiring at App.tsx (product_admin guard + real
// Dashboard swapped in for the prior DashboardStub) is exercised by the
// existing Login.test.tsx + shell tests.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from '../Dashboard';

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

    it('renders three <section> regions keyed by aria-labelledby', () => {
      renderDashboard();
      const portfolio = screen.getByTestId(
        'dashboard-region-portfolio-summary',
      );
      const productGrid = screen.getByTestId(
        'dashboard-region-product-grid',
      );
      const sidebar = screen.getByTestId('dashboard-region-sidebar');
      expect(portfolio.tagName).toBe('SECTION');
      expect(productGrid.tagName).toBe('SECTION');
      expect(sidebar.tagName).toBe('SECTION');
      // Each region references a heading via aria-labelledby (semantic
      // region landmark for assistive tech).
      expect(
        portfolio.getAttribute('aria-labelledby'),
      ).toBeTruthy();
      expect(
        productGrid.getAttribute('aria-labelledby'),
      ).toBeTruthy();
      expect(sidebar.getAttribute('aria-labelledby')).toBeTruthy();
    });

    it('each region carries a placeholder that resolves without throwing (S2/S3/S5 will fill these)', () => {
      renderDashboard();
      expect(
        screen.getByTestId('dashboard-portfolio-summary-placeholder'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('dashboard-product-grid-placeholder'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('dashboard-sidebar-placeholder'),
      ).toBeInTheDocument();
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
