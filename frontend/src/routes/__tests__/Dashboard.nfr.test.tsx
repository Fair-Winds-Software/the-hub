// Authorized by HUB-1650 (E-FE-2 S7) — NFR verification for the Dashboard
// Epic. Extends the HUB-1636 / HUB-1643 pattern with the integration-shape
// gates the per-widget test files cannot reach alone:
//
//   1. axe-core scan on /console/dashboard with all three widget regions
//      mounted (portfolio summary + product grid + sidebar). Zero
//      violations required (AC#2 — Ironclad a11y floor).
//   2. Render perf synthetic assertion — mount + parallel fetches + all
//      three widgets resolved stays under 2500ms (AC#3 § 9 NFR).
//   3. Widget isolation via the WidgetErrorBoundary — a runtime throw or
//      fetch failure in one widget leaves the others fully rendered
//      (AC#3 FR-014).
//
// Lighthouse CWV measurement of /console/dashboard defers to Stage 4 per
// D-HUB-SCOPE-051 (same in-memory session-store constraint as every other
// post-auth route). CI gate continues to measure /console/login.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from '../Dashboard';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const SUMMARY = {
  total_products: 1,
  open_recommendations: 0,
  upgrade_count: 0,
  downgrade_count: 0,
  switch_to_annual_count: 0,
  stay_count: 0,
  high_confidence_count: 0,
  product_cards: [
    {
      product_id: 'p-1',
      product_name: 'Synapz',
      active_tenants: 1,
      mrr_cents: 500_00,
      open_recommendation_count: 0,
      health_badge: 'green',
    },
  ],
  churn_risk: [],
  margin_health: [],
};

const PRODUCTS = {
  data: [
    {
      productId: 'p-1',
      productName: 'Synapz',
      tenantId: 't-1',
      tenantName: 'Maverick Launch',
      status: 'active',
      mrrCents: 500_00,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-06-30T00:00:00.000Z',
    },
  ],
  total: 1,
};

const AUDIT = {
  data: [
    {
      id: 'evt-1',
      operator_id: '11111111-2222-3333-4444-555555555555',
      entity_type: 'plan_assignment',
      entity_id: 'pa-1',
      action: 'plan_assigned',
      tenant_id: 't-1',
      product_id: 'p-1',
      recommendation_id: null,
      created_at: new Date().toISOString(),
    },
  ],
  total: 1,
};

function mockHealthyDashboard() {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
      return Promise.resolve(SUMMARY);
    }
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve(PRODUCTS);
    }
    if (path.startsWith('/api/v1/admin/console/audit-log')) {
      return Promise.resolve(AUDIT);
    }
    // Optional endpoints (portfolio-margin, Jira) — silently unavailable.
    return Promise.reject(new Error('unavailable'));
  });
}

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/console/dashboard']}>
      <Routes>
        <Route path="/console/dashboard" element={<Dashboard />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Dashboard NFR verification (HUB-1650)', () => {
  describe('AC#2 — axe-core zero violations at /console/dashboard', () => {
    it('passes axe scan with all three widget regions mounted', async () => {
      mockHealthyDashboard();
      const { container } = renderDashboard();
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget'),
        ).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId('product-grid-widget')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('dashboard-quick-actions'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#3 — render perf < 2500ms (§ 9 NFR-Performance)', () => {
    it('dashboard mount + parallel fetches + 3-region resolve stays well under 2500ms', async () => {
      mockHealthyDashboard();
      const start = performance.now();
      renderDashboard();
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget'),
        ).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId('product-grid-widget')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('dashboard-quick-actions'),
        ).toBeInTheDocument();
      });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2500);
    });
  });

  describe('AC#3 — widget-isolation invariant (FR-014)', () => {
    it('portfolio summary fetch failure surfaces its own error state; product grid + sidebar continue rendering', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
          return Promise.reject(new Error('summary-endpoint-down'));
        }
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PRODUCTS);
        }
        if (path.startsWith('/api/v1/admin/console/audit-log')) {
          return Promise.resolve(AUDIT);
        }
        return Promise.reject(new Error('unavailable'));
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      renderDashboard();
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-error'),
        ).toBeInTheDocument();
      });
      // Grid + sidebar still fully render.
      expect(screen.getByTestId('product-card-p-1')).toBeInTheDocument();
      expect(
        screen.getByTestId('dashboard-quick-actions'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('activity-row-evt-1'),
      ).toBeInTheDocument();
      errSpy.mockRestore();
    });

    it('product grid failure leaves portfolio summary + sidebar intact', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
          return Promise.resolve(SUMMARY);
        }
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.reject(new Error('products-endpoint-down'));
        }
        if (path.startsWith('/api/v1/admin/console/audit-log')) {
          return Promise.resolve(AUDIT);
        }
        return Promise.reject(new Error('unavailable'));
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      renderDashboard();
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget-error'),
        ).toBeInTheDocument();
      });
      // Portfolio summary tiles + sidebar still render.
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('activity-row-evt-1'),
      ).toBeInTheDocument();
      errSpy.mockRestore();
    });
  });
});
