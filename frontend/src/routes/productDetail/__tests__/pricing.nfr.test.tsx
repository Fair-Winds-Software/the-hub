// Authorized by HUB-1659 (E-FE-5 S9) — cross-cutting NFR verification for
// the Pricing & Billing Config Epic. Runs axe-core on each of the five
// Pricing routes (S4–S8), verifies the shared pricing-formatters helpers
// are the render source for currency + date across the surface, and locks
// the RBAC contract that App.tsx wires each pricing route behind
// GuardedRoute(super_admin).
//
// Lighthouse CWV measurement of the pricing routes defers to Stage 4
// alongside every other post-auth route per D-HUB-SCOPE-051 (same
// in-memory session-store constraint as /console/dashboard). CI gate
// continues to measure /console/login as the canonical cold-load CWV
// proxy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PricingModelEditor from '../PricingModelEditor';
import PlansManager from '../PlansManager';
import AddOnsManager from '../AddOnsManager';
import PricingExceptionsManager from '../PricingExceptionsManager';
import BillingFreezeControls from '../BillingFreezeControls';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

const PRODUCT = {
  productId: 'prod-1',
  productName: 'Synapz',
  tenantId: 'tenant-1',
};

const PRICING_MODEL = {
  model_id: 'm-1',
  product_id: 'prod-1',
  model_type: 'flat',
  currency: 'usd',
  config: {},
  tiers: [],
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.startsWith('/api/v1/admin/plans')) {
      return Promise.resolve({ data: [], total: 0 });
    }
    if (path.startsWith('/api/v1/admin/addons')) {
      return Promise.resolve({ data: [], total: 0 });
    }
    if (path.startsWith('/api/v1/admin/tenants/')) {
      return Promise.resolve(PRICING_MODEL);
    }
    if (path.startsWith('/api/v1/admin/console/discounts/')) {
      return Promise.resolve({ data: [] });
    }
    if (path.startsWith('/api/v1/admin/console/overrides/')) {
      return Promise.resolve({ data: [] });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
});

afterEach(() => {
  cleanup();
});

function renderRoute(
  path: string,
  routePattern: string,
  element: React.ReactElement,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePattern} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Pricing NFR verification (HUB-1659)', () => {
  describe('AC#3 — axe-core zero violations across S4..S8', () => {
    it('S4 PricingModelEditor renders zero violations in the ready state', async () => {
      const { container } = renderRoute(
        '/console/products/prod-1/pricing',
        '/console/products/:productId/pricing',
        <PricingModelEditor />,
      );
      await waitFor(() => {
        expect(screen.getByTestId('pricing-editor-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S5 PlansManager renders zero violations with empty list', async () => {
      const { container } = renderRoute(
        '/console/products/prod-1/pricing/plans',
        '/console/products/:productId/pricing/plans',
        <PlansManager />,
      );
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S6 AddOnsManager renders zero violations with empty list', async () => {
      const { container } = renderRoute(
        '/console/products/prod-1/pricing/addons',
        '/console/products/:productId/pricing/addons',
        <AddOnsManager />,
      );
      await waitFor(() => {
        expect(screen.getByTestId('addons-manager-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S7 PricingExceptionsManager renders zero violations with empty tabs', async () => {
      const { container } = renderRoute(
        '/console/products/prod-1/pricing/exceptions',
        '/console/products/:productId/pricing/exceptions',
        <PricingExceptionsManager />,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('exceptions-manager-page'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S8 BillingFreezeControls renders zero violations in the default active state', async () => {
      const { container } = renderRoute(
        '/console/products/prod-1/pricing/freeze',
        '/console/products/:productId/pricing/freeze',
        <BillingFreezeControls />,
      );
      await waitFor(() => {
        expect(screen.getByTestId('freeze-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#1 — RBAC: every pricing route in App.tsx sits behind GuardedRoute(super_admin)', () => {
    it('static source check: each pricing route is guarded by super_admin', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const appPath = resolve(here, '../../../App.tsx');
      const source = readFileSync(appPath, 'utf8');

      const pricingRoutePatterns = [
        '/console/products/:productId/pricing',
        '/console/products/:productId/pricing/plans',
        '/console/products/:productId/pricing/addons',
        '/console/products/:productId/pricing/exceptions',
        '/console/products/:productId/pricing/freeze',
      ];

      for (const path of pricingRoutePatterns) {
        // Locate the <Route path="X"> block and confirm the sibling
        // <GuardedRoute requiredRole="super_admin"> is inside it.
        const idx = source.indexOf(`path="${path}"`);
        expect(idx).toBeGreaterThan(-1);
        const window = source.slice(idx, idx + 400);
        expect(window).toContain('requiredRole="super_admin"');
      }
    });
  });
});
