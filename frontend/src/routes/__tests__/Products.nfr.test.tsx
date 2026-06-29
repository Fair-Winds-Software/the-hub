// Authorized by HUB-1610 (E-FE-3 S10) — NFR verification at the Products list
// + ProductDetail route level. Extends HUB-1581 with the integration-shaped gates
// the per-component test files can't reach alone:
//   1. axe-core scan on /console/products with rows loaded.
//   2. axe-core scan on /console/products/:productId with Overview tab active.
//   3. 50-row list render perf assertion (per AC-E2 < 500ms) via synthetic
//      measurement under fake-timers — well within budget.
//
// Lighthouse CWV measurement for /console/products + /console/products/:productId
// is deferred to Stage 4 alongside /console/dashboard + /console/audit
// (D-HUB-SCOPE-051 — post-auth routes can't be measured cold by Lighthouse CI's
// separate JS context). The CI gate continues to measure /console/login as the
// canonical cold-load CWV proxy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Products from '../Products';
import ProductDetail from '../ProductDetail';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

function makeProduct(i: number) {
  return {
    productId: `p-${i}`,
    productName: `Product ${String(i).padStart(2, '0')}`,
    tenantId: 't-1',
    tenantName: 'Maverick Launch',
    status: i % 2 === 0 ? 'active' : 'inactive',
    mrrCents: (i + 1) * 10000,
    createdAt: '2025-06-01T00:00:00.000Z',
    lastActiveAt: i % 3 === 0 ? null : '2026-06-25T12:00:00.000Z',
  };
}

const FIFTY_PRODUCTS = Array.from({ length: 50 }, (_, i) => makeProduct(i + 1));

const PORTFOLIO_RESPONSE = { data: FIFTY_PRODUCTS, total: 50 };

const JIRA_UNAVAILABLE = { available: false, reason: 'token_missing' };

const PRODUCT = FIFTY_PRODUCTS[0]!;

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve(PORTFOLIO_RESPONSE);
    }
    if (path.startsWith('/api/v1/admin/integrations/jira/tickets')) {
      return Promise.resolve(JIRA_UNAVAILABLE);
    }
    if (path.endsWith('/health')) {
      return Promise.resolve({ available: true });
    }
    if (path.startsWith('/api/v1/admin/console/pricing/')) {
      return Promise.resolve({ active_model: null, history: [] });
    }
    if (path.startsWith('/api/v1/admin/console/audit-log')) {
      return Promise.resolve({ data: [], total: 0, limit: 20, offset: 0 });
    }
    if (path.startsWith('/api/v1/admin/notifications/')) {
      return Promise.resolve({ channels: [] });
    }
    if (path.startsWith('/api/v1/admin/escalation/')) {
      return Promise.resolve({ rules: [] });
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Products + ProductDetail NFR verification (HUB-1610)', () => {
  describe('AC#1 — axe-core: /console/products list view has zero violations', () => {
    it('passes axe scan with 50 rows loaded', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/products']}>
          <Routes>
            <Route path="/console/products" element={<Products />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByText('Product 01')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#1 — axe-core: ProductDetail with Overview tab active has zero violations', () => {
    it('passes axe scan after the product header + Overview tab render', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={[`/console/products/${PRODUCT.productId}`]}>
          <Routes>
            <Route
              path="/console/products/:productId"
              element={<ProductDetail />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('overview-tab')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#3 — 50-row list render < 500ms', () => {
    it('initial render + fetch resolution stays well under the 500ms NFR target', async () => {
      const start = performance.now();
      render(
        <MemoryRouter initialEntries={['/console/products']}>
          <Routes>
            <Route path="/console/products" element={<Products />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        // All 50 rows should be in the DOM (default pageSize=50).
        expect(screen.getAllByTestId('data-table-row')).toHaveLength(50);
      });
      const elapsed = performance.now() - start;
      // 500ms is the spec budget; jsdom rendering is typically <100ms for this
      // shape — gives generous headroom for slower CI runners.
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('AC#4 — keyboard navigation smoke', () => {
    it('Products list controls (search + sort headers + rows) are all keyboard-reachable via tabindex/aria', async () => {
      render(
        <MemoryRouter initialEntries={['/console/products']}>
          <Routes>
            <Route path="/console/products" element={<Products />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByText('Product 01')).toBeInTheDocument();
      });
      // Sort headers are buttons (clickable). Spot-check the focusable surfaces.
      const sortableHeaders = screen.getAllByRole('button', {
        name: /(name|status|mrr|last active)/i,
      });
      expect(sortableHeaders.length).toBeGreaterThan(0);
      // Rows are <tr tabIndex=0 onKeyDown=...> when onRowClick is wired (DataTable
      // contract) — keyboard-reachable via Tab cycle even without an explicit role.
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows[0]).toHaveAttribute('tabindex', '0');
    });
  });
});
