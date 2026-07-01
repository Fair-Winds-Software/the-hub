// Authorized by HUB-1649 (E-FE-2 S6) — RBAC scope wiring integration test
// for the Dashboard Epic. The single-tenant RBAC model (D-HUB-SCOPE-035)
// means:
//
//   - Product grid: /api/v1/admin/portfolio/products already filters by the
//     operator's tenant_id server-side (HUB-1700). product_admin sees only
//     their tenant's products; super_admin sees everything. The FE does NOT
//     re-filter — it renders whatever the server returns. This matches the
//     spec's intent (never mask server bugs) even though the underlying
//     mechanism is tenant scoping rather than the spec's originally-stated
//     scoped_products[] JWT claim (see HUB-1574: useRBACGuard is role-only
//     because scope is tenant-level, not per-product, in v0.1).
//
//   - Activity feed: /api/v1/admin/console/audit-log is server-scoped by
//     operatorRbac.ts (per spec FR-013). The FE renders whatever comes
//     back. product_admin without product_id gets a 400 which the feed
//     collapses to the friendly degraded state (widget-isolation rule).
//
//   - URL-hack: the HUB-1555 GuardedRoute plus per-endpoint 403 handling
//     (HUB-1642 pattern) already redirect / render AccessDeniedPage for
//     out-of-scope resource IDs. That belongs to the per-detail-route test
//     suites (e.g., Products, ProductDetail, plan-advisor) and is not
//     re-tested here.
//
// This suite proves both dashboard scoping paths behave as the story asks:
// grid + feed render exactly what the server returns; a scoped product_admin
// server response yields a scoped FE view; the feed's degrade path never
// cascades to the grid.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from '../../Dashboard';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT_A = {
  productId: 'product-A',
  productName: 'Product A (in scope)',
  tenantId: 'tenant-1',
  tenantName: 'Maverick Launch',
  status: 'active',
  mrrCents: 250_00,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-06-30T00:00:00.000Z',
};

const PRODUCT_B = {
  productId: 'product-B',
  productName: 'Product B (out of scope)',
  tenantId: 'tenant-2',
  tenantName: 'Other Tenant',
  status: 'active',
  mrrCents: 900_00,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-06-30T00:00:00.000Z',
};

const EMPTY_SUMMARY = {
  total_products: 0,
  open_recommendations: 0,
  upgrade_count: 0,
  downgrade_count: 0,
  switch_to_annual_count: 0,
  stay_count: 0,
  high_confidence_count: 0,
  product_cards: [],
  churn_risk: [],
  margin_health: [],
};

const AUDIT_ENTRY_TENANT_1 = {
  id: 'evt-1',
  operator_id: '11111111-2222-3333-4444-555555555555',
  entity_type: 'plan_assignment',
  entity_id: 'pa-1',
  action: 'plan_assigned',
  tenant_id: 'tenant-1',
  product_id: 'product-A',
  recommendation_id: null,
  created_at: new Date().toISOString(),
};

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

describe('HUB-1649 — Dashboard RBAC scope wiring', () => {
  it('product_admin server response (tenant-scoped) → grid renders only in-scope products', async () => {
    // Simulate the server-side tenant scope filter having already run —
    // product_admin's /portfolio/products call returns just product-A.
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
        return Promise.resolve(EMPTY_SUMMARY);
      }
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({ data: [PRODUCT_A], total: 1 });
      }
      if (path.startsWith('/api/v1/admin/console/audit-log')) {
        return Promise.resolve({ data: [AUDIT_ENTRY_TENANT_1], total: 1 });
      }
      return Promise.reject(new Error(`unexpected: ${path}`));
    });

    await act(async () => {
      renderDashboard();
    });
    await waitFor(() => {
      expect(screen.getByTestId('product-card-product-A')).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('product-card-product-B'),
    ).toBeNull();
  });

  it('super_admin server response (unfiltered) → grid renders every product', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
        return Promise.resolve(EMPTY_SUMMARY);
      }
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({
          data: [PRODUCT_A, PRODUCT_B],
          total: 2,
        });
      }
      if (path.startsWith('/api/v1/admin/console/audit-log')) {
        return Promise.resolve({ data: [], total: 0 });
      }
      return Promise.reject(new Error(`unexpected: ${path}`));
    });

    await act(async () => {
      renderDashboard();
    });
    await waitFor(() => {
      expect(screen.getByTestId('product-card-product-A')).toBeInTheDocument();
    });
    expect(screen.getByTestId('product-card-product-B')).toBeInTheDocument();
  });

  it('activity feed renders EXACTLY what the server returned (no FE re-filter)', async () => {
    // Server returned an entry for tenant-1; the feed must render it as-is
    // — re-filtering on the FE would mask server bugs.
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
        return Promise.resolve(EMPTY_SUMMARY);
      }
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({ data: [PRODUCT_A], total: 1 });
      }
      if (path.startsWith('/api/v1/admin/console/audit-log')) {
        return Promise.resolve({
          data: [AUDIT_ENTRY_TENANT_1],
          total: 1,
        });
      }
      return Promise.reject(new Error(`unexpected: ${path}`));
    });
    await act(async () => {
      renderDashboard();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('activity-row-evt-1'),
      ).toBeInTheDocument();
    });
  });

  it('product_admin without product_id → audit-log 400 → feed degrades WITHOUT cascading to the grid', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
        return Promise.resolve(EMPTY_SUMMARY);
      }
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({ data: [PRODUCT_A], total: 1 });
      }
      if (path.startsWith('/api/v1/admin/console/audit-log')) {
        return Promise.reject(new Error('PRODUCT_ID_REQUIRED'));
      }
      return Promise.reject(new Error(`unexpected: ${path}`));
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderDashboard();
    });
    // Grid still shows the scoped product.
    await waitFor(() => {
      expect(screen.getByTestId('product-card-product-A')).toBeInTheDocument();
    });
    // Activity feed shows the degraded panel — the quick actions row above
    // stays fully mounted.
    await waitFor(() => {
      expect(
        screen.getByTestId('dashboard-activity-degraded'),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('dashboard-quick-actions')).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
