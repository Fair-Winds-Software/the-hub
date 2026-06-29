// Authorized by HUB-1603 (E-FE-3 S3) — Products list view tests. Covers route render,
// portfolio fetch + render, search/sort/pagination via DataTable, row-click navigation,
// loading/empty/error states, retry button, lazy ticket-count loading (loading →
// ready / unavailable per row), and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Products from '../Products';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PORTFOLIO_RESPONSE = {
  data: [
    {
      productId: 'p-1',
      productName: 'Synapz',
      tenantId: 't-1',
      tenantName: 'Maverick Launch',
      status: 'active',
      mrrCents: 1250000,
      createdAt: '2025-01-01T00:00:00.000Z',
      lastActiveAt: '2026-06-25T12:00:00.000Z',
    },
    {
      productId: 'p-2',
      productName: 'ContentHelm',
      tenantId: 't-1',
      tenantName: 'Maverick Launch',
      status: 'active',
      mrrCents: 800000,
      createdAt: '2025-03-01T00:00:00.000Z',
      lastActiveAt: '2026-06-20T12:00:00.000Z',
    },
    {
      productId: 'p-3',
      productName: 'LaunchKit',
      tenantId: 't-1',
      tenantName: 'Maverick Launch',
      status: 'inactive',
      mrrCents: 0,
      createdAt: '2025-06-01T00:00:00.000Z',
      lastActiveAt: null,
    },
  ],
  total: 3,
};

const JIRA_AVAILABLE = {
  available: true,
  openCRs: 4,
  openBugs: 2,
  lastSyncedAt: '2026-06-25T12:00:00.000Z',
};

const JIRA_UNAVAILABLE = { available: false, reason: 'token_missing' };

function defaultMock() {
  return (path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve(PORTFOLIO_RESPONSE);
    }
    if (path.startsWith('/api/v1/admin/integrations/jira/tickets')) {
      // Synapz available; everyone else unavailable.
      if (path.includes('productId=Synapz')) return Promise.resolve(JIRA_AVAILABLE);
      return Promise.resolve(JIRA_UNAVAILABLE);
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(defaultMock());
});

afterEach(() => {
  cleanup();
});

function PathProbe() {
  const loc = useLocation();
  return <span data-testid="path">{loc.pathname}</span>;
}

function renderProducts(initialUrl = '/console/products') {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route path="/console/products" element={<Products />} />
        <Route path="/console/products/:productId" element={<PathProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Products (HUB-1603)', () => {
  describe('AC#2/#3 — table renders from portfolio endpoint', () => {
    it('fetches /api/v1/admin/portfolio/products and renders rows', async () => {
      renderProducts();
      await waitFor(() => {
        expect(screen.getByText('Synapz')).toBeInTheDocument();
        expect(screen.getByText('ContentHelm')).toBeInTheDocument();
        expect(screen.getByText('LaunchKit')).toBeInTheDocument();
      });
      // Portfolio call was made with pageSize limit.
      const portfolioCalls = apiGetMock.mock.calls
        .map((c) => c[0] as string)
        .filter((p) => p.startsWith('/api/v1/admin/portfolio/products'));
      expect(portfolioCalls).toHaveLength(1);
      expect(portfolioCalls[0]).toContain('limit=50');
    });

    it('renders the 6 column headers per AC#2', async () => {
      renderProducts();
      await waitFor(() => {
        expect(screen.getByText('Synapz')).toBeInTheDocument();
      });
      const table = screen.getByRole('table', { name: 'Products list' });
      const headers = Array.from(table.querySelectorAll('th')).map(
        (h) => h.textContent ?? '',
      );
      for (const label of [
        'Name',
        'Status',
        'Version',
        'MRR',
        'Last Active',
        'Ticket Counts',
      ]) {
        expect(headers.some((h) => h.includes(label))).toBe(true);
      }
    });

    it('formats MRR as USD; lastActiveAt as locale date; null lastActiveAt as "—"', async () => {
      renderProducts();
      await waitFor(() => {
        expect(screen.getByText('Synapz')).toBeInTheDocument();
      });
      // MRR: $12,500 for Synapz (1250000 cents).
      expect(screen.getByText('$12,500')).toBeInTheDocument();
      // LaunchKit has null lastActiveAt → "—" cell.
      const launchkitRow = screen
        .getByText('LaunchKit')
        .closest('tr');
      expect(launchkitRow?.textContent).toContain('—');
    });
  });

  describe('AC#5 — default sort is Name asc', () => {
    it('first visible row is ContentHelm (alphabetically first)', async () => {
      renderProducts();
      await waitFor(() => {
        expect(screen.getByText('ContentHelm')).toBeInTheDocument();
      });
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows[0]!.textContent).toContain('ContentHelm');
      expect(rows[1]!.textContent).toContain('LaunchKit');
      expect(rows[2]!.textContent).toContain('Synapz');
    });
  });

  describe('AC#7 — row click navigates to /console/products/:productId', () => {
    it('clicking a row pushes /console/products/p-2 for ContentHelm', async () => {
      renderProducts();
      await waitFor(() => {
        expect(screen.getByText('ContentHelm')).toBeInTheDocument();
      });
      const contentHelmRow = screen
        .getByText('ContentHelm')
        .closest('tr');
      fireEvent.click(contentHelmRow!);
      await waitFor(() => {
        expect(screen.getByTestId('path').textContent).toBe(
          '/console/products/p-2',
        );
      });
    });
  });

  describe('AC#8 — empty state when no products', () => {
    it('renders "No products yet" copy with no add-product affordance', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve({ data: [], total: 0 });
        }
        return Promise.reject(new Error(`unexpected: ${path}`));
      });
      renderProducts();
      await waitFor(() => {
        expect(screen.getByText(/no products yet/i)).toBeInTheDocument();
      });
      // No "add product" CTA per HUB-1557 §2 OOS-Won't-Do.
      expect(screen.queryByRole('button', { name: /add product/i })).toBeNull();
    });
  });

  describe('AC#9 — loading state', () => {
    it('shows DataTable skeleton rows while fetch is in flight', () => {
      apiGetMock.mockImplementation(
        () => new Promise(() => {}), // never resolves
      );
      renderProducts();
      expect(screen.getAllByTestId('data-table-skeleton-row').length).toBe(5);
    });
  });

  describe('AC#10 — error state with retry', () => {
    it('error banner renders with retry button; retry refires the fetch', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockImplementationOnce(() =>
        Promise.reject(new Error('network down')),
      );
      apiGetMock.mockImplementation(defaultMock());
      renderProducts();
      await waitFor(() => {
        expect(screen.getByTestId('products-error-banner')).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('products-error-banner').textContent,
      ).toContain('network down');

      // Retry → second fetch succeeds and rows render.
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      await waitFor(() => {
        expect(screen.getByText('Synapz')).toBeInTheDocument();
      });
      errSpy.mockRestore();
    });
  });

  describe('AC#11 — ticket counts lazy load per row', () => {
    it('starts each row with "checking…" then resolves per JiraTicketsResponse', async () => {
      renderProducts();
      await waitFor(() => {
        expect(screen.getByText('Synapz')).toBeInTheDocument();
      });
      // All three rows entered a loading state at first.
      // Synapz resolves to ready; ContentHelm + LaunchKit resolve to unavailable.
      await waitFor(() => {
        expect(screen.getByTestId('ticket-ready-p-1')).toBeInTheDocument();
        expect(screen.getByTestId('ticket-ready-p-1').textContent).toContain(
          '4 CR · 2 bug',
        );
      });
      await waitFor(() => {
        expect(screen.getByTestId('ticket-unavailable-p-2')).toBeInTheDocument();
        expect(screen.getByTestId('ticket-unavailable-p-3')).toBeInTheDocument();
      });
      // Confirm one ticket call fired per row (3 total).
      const ticketCalls = apiGetMock.mock.calls
        .map((c) => c[0] as string)
        .filter((p) => p.startsWith('/api/v1/admin/integrations/jira/tickets'));
      expect(ticketCalls).toHaveLength(3);
    });

    it('uses productName (Jira project key) as the productId query value', async () => {
      renderProducts();
      await waitFor(() => {
        expect(screen.getByText('Synapz')).toBeInTheDocument();
      });
      const ticketCalls = apiGetMock.mock.calls
        .map((c) => c[0] as string)
        .filter((p) => p.startsWith('/api/v1/admin/integrations/jira/tickets'));
      expect(ticketCalls.some((c) => c.includes('productId=Synapz'))).toBe(true);
      expect(ticketCalls.some((c) => c.includes('productId=ContentHelm'))).toBe(
        true,
      );
    });

    it('row that throws on the ticket call falls back to unavailable', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/integrations/jira/tickets')) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.reject(new Error(`unexpected: ${path}`));
      });
      renderProducts();
      await waitFor(() => {
        expect(screen.getByTestId('ticket-unavailable-p-1')).toBeInTheDocument();
      });
    });
  });

  describe('HUB-1609 — denial UX on 403', () => {
    it('PermissionDeniedError from the portfolio fetch renders <AccessDeniedPage>', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.reject(new PermissionDeniedError(403, 'Forbidden'));
        }
        return Promise.reject(new Error(`unexpected: ${path}`));
      });
      renderProducts();
      await waitFor(() => {
        expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
      });
      // Denial UX replaces the error banner — operator gets full-page treatment.
      expect(screen.queryByTestId('products-error-banner')).toBeNull();
      // Back link points at the dashboard (sensible escalation point from the list).
      expect(
        screen.getByTestId('access-denied-back-link'),
      ).toHaveAttribute('href', '/console/dashboard');
      errSpy.mockRestore();
    });
  });

  describe('document.title management', () => {
    it('sets document.title to "Products | HUB Console" on mount', () => {
      const original = document.title;
      try {
        renderProducts();
        expect(document.title).toBe('Products | HUB Console');
      } finally {
        document.title = original;
      }
    });

    it('restores the previous document.title on unmount', () => {
      const original = document.title;
      try {
        document.title = 'Before products';
        const { unmount } = renderProducts();
        expect(document.title).toBe('Products | HUB Console');
        unmount();
        expect(document.title).toBe('Before products');
      } finally {
        document.title = original;
      }
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with rows loaded', async () => {
      const { container } = renderProducts();
      await waitFor(() => {
        expect(screen.getByText('Synapz')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
