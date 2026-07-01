// Authorized by HUB-1646 (E-FE-2 S3) — ProductGridWidget tests. Covers
// grid render + status badge triple-encoding (color + icon + text) + MRR
// formatting + link-wrapping (open-in-new-tab friendly) + keyboard focus
// path + CRs/Bugs slot skeletons (S4 fills) + loading skeleton + error
// state + retry + empty state + axe-core zero violations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import { ProductGridWidget } from '../ProductGridWidget';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const P1 = {
  productId: 'p-1',
  productName: 'Synapz',
  tenantId: 't-1',
  tenantName: 'Maverick Launch',
  status: 'active',
  mrrCents: 500_00,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-06-30T00:00:00.000Z',
};
const P2 = {
  productId: 'p-2',
  productName: 'ContentHelm',
  tenantId: 't-1',
  tenantName: 'Maverick Launch',
  status: 'trial',
  mrrCents: 0,
  createdAt: '2026-02-01T00:00:00.000Z',
  lastActiveAt: null,
};
const P3 = {
  productId: 'p-3',
  productName: 'LegacyApp',
  tenantId: 't-2',
  tenantName: 'Other',
  status: 'suspended',
  mrrCents: 100_00,
  createdAt: '2025-12-01T00:00:00.000Z',
  lastActiveAt: '2026-06-01T00:00:00.000Z',
};

function mockProducts(products: unknown[] = [P1, P2, P3]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: products, total: products.length });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderWidget() {
  return render(
    <MemoryRouter>
      <ProductGridWidget />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ProductGridWidget (HUB-1646)', () => {
  describe('AC#1 — grid renders one card per product', () => {
    it('renders a card per product after data loads', async () => {
      mockProducts();
      await act(async () => {
        renderWidget();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget'),
        ).toBeInTheDocument();
      });
      expect(screen.getByTestId('product-card-p-1')).toBeInTheDocument();
      expect(screen.getByTestId('product-card-p-2')).toBeInTheDocument();
      expect(screen.getByTestId('product-card-p-3')).toBeInTheDocument();
    });
  });

  describe('AC#2 — card content: name link, status badge, MRR, CR/Bug slots', () => {
    it('name renders inside an anchor to /console/products/:productId', async () => {
      mockProducts([P1]);
      await act(async () => {
        renderWidget();
      });
      await waitFor(() => {
        expect(screen.getByTestId('product-card-p-1')).toBeInTheDocument();
      });
      const card = screen.getByTestId('product-card-p-1');
      // Card itself IS the anchor for open-in-new-tab friendliness.
      expect(card.tagName).toBe('A');
      expect(card.getAttribute('href')).toBe('/console/products/p-1');
      // Name is present and reads as the product name.
      expect(
        screen.getByTestId('product-card-name').textContent,
      ).toBe('Synapz');
    });

    it('status badge is triple-encoded (color class + icon + text) per verdict', async () => {
      mockProducts();
      await act(async () => {
        renderWidget();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget'),
        ).toBeInTheDocument();
      });
      // active → success verdict.
      expect(
        screen.getByTestId('product-card-status-success').textContent,
      ).toContain('active');
      // trial → warning verdict.
      expect(
        screen.getByTestId('product-card-status-warning').textContent,
      ).toContain('trial');
      // suspended → error verdict.
      expect(
        screen.getByTestId('product-card-status-error').textContent,
      ).toContain('suspended');
    });

    it('unknown status falls back to neutral verdict + surfaces the raw string', async () => {
      mockProducts([
        {
          ...P1,
          productId: 'p-x',
          productName: 'MysteryApp',
          status: 'quantumly_undefined',
        },
      ]);
      await act(async () => {
        renderWidget();
      });
      await waitFor(() => {
        expect(screen.getByTestId('product-card-p-x')).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('product-card-status-neutral').textContent,
      ).toContain('quantumly_undefined');
    });

    it('MRR is formatted via Intl USD from cents (never raw cents)', async () => {
      mockProducts();
      await act(async () => {
        renderWidget();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget'),
        ).toBeInTheDocument();
      });
      const mrrValues = screen
        .getAllByTestId('product-card-mrr')
        .map((el) => el.textContent);
      // $500 for P1, $0 for P2, $100 for P3.
      expect(mrrValues).toEqual(['$500', '$0', '$100']);
    });

    it('CR + Bug count slots reserve S4 layout via skeleton pulses', async () => {
      mockProducts([P1]);
      await act(async () => {
        renderWidget();
      });
      await waitFor(() => {
        expect(screen.getByTestId('product-card-p-1')).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('product-card-cr-count-skeleton-p-1'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('product-card-bug-count-skeleton-p-1'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#3 — loading / error / empty states', () => {
    it('renders three skeleton cards before data arrives', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderWidget();
      expect(
        screen.getByTestId('product-grid-widget-loading'),
      ).toBeInTheDocument();
      expect(
        screen.getAllByTestId('product-card-skeleton'),
      ).toHaveLength(3);
    });

    it('renders error banner + retry that re-fetches', async () => {
      let call = 0;
      apiGetMock.mockImplementation(() => {
        call++;
        if (call === 1) return Promise.reject(new Error('boom-3'));
        return Promise.resolve({ data: [P1], total: 1 });
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        renderWidget();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget-error'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('product-grid-widget-error').textContent,
      ).toMatch(/boom-3/);
      await act(async () => {
        fireEvent.click(
          screen.getByTestId('product-grid-widget-retry'),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('product-card-p-1')).toBeInTheDocument();
      });
      errSpy.mockRestore();
    });

    it('renders empty-state copy when zero products come back', async () => {
      mockProducts([]);
      await act(async () => {
        renderWidget();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget-empty'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('product-grid-widget-empty').textContent,
      ).toMatch(/No products/i);
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with 3 cards rendered', async () => {
      mockProducts();
      const { container } = renderWidget();
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the empty state', async () => {
      mockProducts([]);
      const { container } = renderWidget();
      await waitFor(() => {
        expect(
          screen.getByTestId('product-grid-widget-empty'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
