// Authorized by HUB-1604 (E-FE-3 S4) — ProductDetail scaffold tests. Covers loading
// skeleton, error banner with back link, 404 not-found state, header render (name +
// key + status badge), 5-tab strip with correct labels, Pricing Model link-only
// behavior, URL deep-link to specific tab, and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductDetail from '../ProductDetail';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT = {
  productId: 'p-1',
  productName: 'Synapz',
  tenantId: 't-1',
  tenantName: 'Maverick Launch',
  status: 'active',
  mrrCents: 1250000,
  createdAt: '2025-01-01T00:00:00.000Z',
  lastActiveAt: '2026-06-25T12:00:00.000Z',
};

const PORTFOLIO_RESPONSE = { data: [PRODUCT], total: 1 };

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve(PORTFOLIO_RESPONSE);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
});

afterEach(() => {
  cleanup();
});

function renderDetail(productId: string, search = '') {
  return render(
    <MemoryRouter initialEntries={[`/console/products/${productId}${search}`]}>
      <Routes>
        <Route path="/console/products/:productId" element={<ProductDetail />} />
        <Route path="/console/products" element={<div data-testid="list-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProductDetail (HUB-1604)', () => {
  describe('AC#7 — loading state', () => {
    it('renders header + tab strip skeletons while fetch is in flight', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderDetail('p-1');
      expect(screen.getByTestId('product-header-skeleton')).toBeInTheDocument();
      expect(screen.getByTestId('product-tabs-skeleton')).toBeInTheDocument();
    });
  });

  describe('AC#2 — header renders name + status badge + key', () => {
    it('renders product name in h1; status badge; product key', async () => {
      renderDetail('p-1');
      await waitFor(() => {
        expect(screen.getByTestId('product-detail-name')).toBeInTheDocument();
      });
      const h1 = screen.getByRole('heading', { level: 1, name: 'Synapz' });
      expect(h1).toBeInTheDocument();
      expect(screen.getByTestId('product-status-badge')).toHaveTextContent('active');
      expect(screen.getByTestId('product-detail-key').textContent).toContain('p-1');
    });
  });

  describe('AC#3 — 5-tab strip with correct labels', () => {
    it('renders Overview / Plans / Pricing Model / Audit / Notifications tabs', async () => {
      renderDetail('p-1');
      await waitFor(() => {
        expect(screen.getByTestId('product-detail-name')).toBeInTheDocument();
      });
      for (const id of ['overview', 'plans', 'pricing', 'audit', 'notifications']) {
        expect(screen.getByTestId(`tab-${id}`)).toBeInTheDocument();
      }
      const tablist = screen.getByRole('tablist', { name: 'Product detail tabs' });
      expect(tablist).toBeInTheDocument();
    });

    it('defaults to the Overview tab when no URL param', async () => {
      renderDetail('p-1');
      await waitFor(() => {
        expect(screen.getByTestId('tab-overview')).toHaveAttribute(
          'aria-selected',
          'true',
        );
      });
    });
  });

  describe('AC#4 — Pricing Model is link-only (per D2)', () => {
    it('Pricing Model tab content is the Edit pricing model CTA (no inline editor)', async () => {
      renderDetail('p-1', '?tab=pricing');
      await waitFor(() => {
        expect(screen.getByTestId('tab-pricing')).toHaveAttribute(
          'aria-selected',
          'true',
        );
      });
      const cta = screen.getByTestId('pricing-model-cta');
      expect(cta).toBeInTheDocument();
      expect(cta).toHaveAttribute('href', '/console/products/p-1/pricing');
      expect(cta.textContent).toMatch(/edit pricing model/i);
    });
  });

  describe('AC#6 — URL deep-link to specific tab', () => {
    it('?tab=audit lands with Audit tab active', async () => {
      renderDetail('p-1', '?tab=audit');
      await waitFor(() => {
        expect(screen.getByTestId('tab-audit')).toHaveAttribute(
          'aria-selected',
          'true',
        );
      });
      // AuditTab (HUB-1607) renders inside the tab panel. The audit-log fetch
      // here will reject (mock only handles /portfolio/products); we just
      // verify the AuditTab shell is in the DOM, which is sufficient proof
      // of the deep-link → tab-content wiring.
      expect(screen.getByTestId('audit-tab')).toBeInTheDocument();
    });
  });

  describe('AC#9 — 404 not-found', () => {
    it('unknown productId renders Product not found + back link', async () => {
      renderDetail('p-does-not-exist');
      await waitFor(() => {
        expect(screen.getByTestId('product-not-found')).toBeInTheDocument();
      });
      expect(screen.getByRole('link', { name: /back to products/i })).toHaveAttribute(
        'href',
        '/console/products',
      );
    });
  });

  describe('AC#8 — error state on fetch failure', () => {
    it('full-page error banner with back link when portfolio fetch fails', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockImplementation(() =>
        Promise.reject(new Error('boom')),
      );
      renderDetail('p-1');
      await waitFor(() => {
        expect(screen.getByTestId('product-detail-error')).toBeInTheDocument();
      });
      expect(screen.getByTestId('product-detail-error').textContent).toContain('boom');
      expect(screen.getByRole('link', { name: /back to products/i })).toHaveAttribute(
        'href',
        '/console/products',
      );
      errSpy.mockRestore();
    });
  });

  describe('document.title management', () => {
    it('sets title to "<productName> | HUB Console" after fetch resolves', async () => {
      const original = document.title;
      try {
        renderDetail('p-1');
        await waitFor(() => {
          expect(document.title).toBe('Synapz | HUB Console');
        });
      } finally {
        document.title = original;
      }
    });
  });

  describe('HUB-1609 — denial UX on 403 (URL-hack)', () => {
    it('PermissionDeniedError on portfolio fetch renders <AccessDeniedPage> (distinct from not-found)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockImplementation(() =>
        Promise.reject(new PermissionDeniedError(403, 'Forbidden')),
      );
      renderDetail('p-out-of-scope');
      await waitFor(() => {
        expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
      });
      // Denial replaces both error banner and not-found.
      expect(screen.queryByTestId('product-detail-error')).toBeNull();
      expect(screen.queryByTestId('product-not-found')).toBeNull();
      // Back link points to the products list.
      expect(screen.getByTestId('access-denied-back-link')).toHaveAttribute(
        'href',
        '/console/products',
      );
      errSpy.mockRestore();
    });

    it('not-found still renders for an in-portfolio but unknown productId (NOT denial)', async () => {
      // Default mock returns the portfolio with PRODUCT p-1 only.
      renderDetail('p-does-not-exist');
      await waitFor(() => {
        expect(screen.getByTestId('product-not-found')).toBeInTheDocument();
      });
      // Confirms not-found and denial are distinct per spec AC#2.
      expect(screen.queryByTestId('access-denied-page')).toBeNull();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan in the loaded-ready state', async () => {
      const { container } = renderDetail('p-1');
      await waitFor(() => {
        expect(screen.getByTestId('product-detail-name')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the not-found state', async () => {
      const { container } = renderDetail('p-does-not-exist');
      await waitFor(() => {
        expect(screen.getByTestId('product-not-found')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
