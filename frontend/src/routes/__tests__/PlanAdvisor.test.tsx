// Authorized by HUB-1638 (E-FE-4 S2) — PlanAdvisor list-view tests. Covers
// fetch wiring + endpoint + query params, 6-column table, outcome badge
// variants, Product + Outcome filter dropdowns + URL sync, "pending" UI
// pseudo-value filtering (translates to omitted outcome param + client-side
// null filter), Cross-Epic deep-link from HUB-1607 (?productId=<id>),
// New Recommendation CTA → /console/plan-advisor/new, row click →
// /console/plan-advisor/:runId, empty + loading + error + retry, HUB-1642
// preview denial UX, document.title, and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import PlanAdvisor from '../PlanAdvisor';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const ROWS = [
  {
    recommendationId: 'r-1',
    productId: 'p-1',
    tenantId: 't-1',
    productName: 'Synapz',
    currentPlan: null,
    recommendedPlan: 'Pro',
    reasoning: 'Usage exceeds standard tier',
    mrrImpact: 50,
    outcome: 'won',
    outcomeNote: null,
    createdAt: '2026-06-25T12:00:00.000Z',
    outcomeCapturedAt: '2026-06-26T12:00:00.000Z',
    operatorEmail: null,
  },
  {
    recommendationId: 'r-2',
    productId: 'p-2',
    tenantId: 't-1',
    productName: 'ContentHelm',
    currentPlan: null,
    recommendedPlan: 'Credit',
    reasoning: 'Variable usage pattern',
    mrrImpact: -10,
    outcome: 'lost',
    outcomeNote: null,
    createdAt: '2026-06-20T12:00:00.000Z',
    outcomeCapturedAt: '2026-06-22T12:00:00.000Z',
    operatorEmail: null,
  },
  {
    recommendationId: 'r-3',
    productId: 'p-3',
    tenantId: 't-1',
    productName: 'LaunchKit',
    currentPlan: null,
    recommendedPlan: 'Tiered',
    reasoning: 'No decision yet',
    mrrImpact: 0,
    outcome: null, // pending
    outcomeNote: null,
    createdAt: '2026-06-29T12:00:00.000Z',
    outcomeCapturedAt: null,
    operatorEmail: null,
  },
];

const LIST_RESPONSE = { data: ROWS, total: 3 };

const PORTFOLIO_RESPONSE = {
  data: [
    { productId: 'p-1', productName: 'Synapz' },
    { productId: 'p-2', productName: 'ContentHelm' },
  ],
  total: 2,
};

function defaultMock() {
  return (path: string) => {
    if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
      return Promise.resolve(LIST_RESPONSE);
    }
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve(PORTFOLIO_RESPONSE);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
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
  return (
    <span data-testid="path">
      {loc.pathname}
      {loc.search}
    </span>
  );
}

function renderPage(initialUrl = '/console/plan-advisor') {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route path="/console/plan-advisor" element={<PlanAdvisor />} />
        <Route path="/console/plan-advisor/new" element={<PathProbe />} />
        <Route
          path="/console/plan-advisor/:runId"
          element={<PathProbe />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function lastListCall(): { path: string; search: URLSearchParams } | undefined {
  const calls = apiGetMock.mock.calls
    .map((c) => c[0] as string)
    .filter((p) => p.startsWith('/api/v1/admin/advisor/recommendations'));
  if (calls.length === 0) return undefined;
  const url = calls[calls.length - 1]!;
  const qsIndex = url.indexOf('?');
  return {
    path: qsIndex === -1 ? url : url.slice(0, qsIndex),
    search: new URLSearchParams(qsIndex === -1 ? '' : url.slice(qsIndex + 1)),
  };
}

describe('PlanAdvisor (HUB-1638)', () => {
  describe('AC#2/#3 — fetch wiring + 6 columns', () => {
    it('fetches /api/v1/admin/advisor/recommendations on mount', async () => {
      renderPage();
      await waitFor(() => {
        const call = lastListCall();
        expect(call).toBeDefined();
        expect(call!.path).toBe('/api/v1/admin/advisor/recommendations');
      });
    });

    it('renders the 6 spec column headers', async () => {
      renderPage();
      await waitFor(() => {
        // Synapz appears in both the table AND the product filter dropdown;
        // assert on the data-table row presence directly instead.
        expect(screen.getAllByTestId('data-table-row').length).toBeGreaterThan(0);
      });
      const table = screen.getByRole('table', {
        name: 'Plan advisor recommendations',
      });
      const headers = Array.from(table.querySelectorAll('th')).map(
        (h) => h.textContent ?? '',
      );
      for (const label of [
        'Timestamp',
        'Product',
        'Current Plan',
        'Recommended Plan',
        'Outcome',
        'Operator',
      ]) {
        expect(headers.some((h) => h.includes(label))).toBe(true);
      }
    });

    it('null currentPlan + null operatorEmail render as "—" per spec deviation #3', async () => {
      renderPage();
      await waitFor(() => {
        // Synapz appears in both the table AND the product filter dropdown;
        // assert on the data-table row presence directly instead.
        expect(screen.getAllByTestId('data-table-row').length).toBeGreaterThan(0);
      });
      // Every row's Current Plan cell + Operator cell shows the em-dash since
      // the BE returns null at v0.1.
      const rows = screen.getAllByTestId('data-table-row');
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(
          (td) => td.textContent ?? '',
        );
        // Current Plan = col index 2; Operator = col index 5
        expect(cells[2]).toBe('—');
        expect(cells[5]).toBe('—');
      }
    });
  });

  describe('outcome badge variants', () => {
    it('renders the won badge + lost badge + pending badge per row outcome', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('advisor-outcome-won')).toBeInTheDocument();
      });
      expect(screen.getByTestId('advisor-outcome-lost')).toBeInTheDocument();
      // r-3 has outcome=null → renders the "pending" pseudo-badge.
      expect(screen.getByTestId('advisor-outcome-pending')).toBeInTheDocument();
    });
  });

  describe('AC#4 — filter dropdowns + URL sync', () => {
    it('selecting a product mirrors into ?productId= AND re-fires the fetch with the filter', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-advisor-product-filter'),
        ).toBeInTheDocument();
      });
      // Wait for portfolio to populate the dropdown so we can pick p-1.
      await waitFor(() => {
        const filter = screen.getByTestId(
          'plan-advisor-product-filter',
        ) as HTMLSelectElement;
        expect(
          Array.from(filter.options).some((o) => o.value === 'p-1'),
        ).toBe(true);
      });
      apiGetMock.mockClear();
      apiGetMock.mockImplementation(defaultMock());

      fireEvent.change(screen.getByTestId('plan-advisor-product-filter'), {
        target: { value: 'p-1' },
      });
      await waitFor(() => {
        const call = lastListCall();
        expect(call?.search.get('productId')).toBe('p-1');
      });
    });

    it('selecting outcome=won re-fires the fetch with outcome=won', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-advisor-outcome-filter'),
        ).toBeInTheDocument();
      });
      apiGetMock.mockClear();
      apiGetMock.mockImplementation(defaultMock());
      fireEvent.change(screen.getByTestId('plan-advisor-outcome-filter'), {
        target: { value: 'won' },
      });
      await waitFor(() => {
        expect(lastListCall()?.search.get('outcome')).toBe('won');
      });
    });

    it('outcome="pending" UI pseudo-value OMITS outcome from the request AND filters client-side', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-advisor-outcome-filter'),
        ).toBeInTheDocument();
      });
      apiGetMock.mockClear();
      apiGetMock.mockImplementation(defaultMock());
      fireEvent.change(screen.getByTestId('plan-advisor-outcome-filter'), {
        target: { value: 'pending' },
      });
      await waitFor(() => {
        const call = lastListCall();
        expect(call).toBeDefined();
        expect(call!.search.get('outcome')).toBeNull();
      });
      // Client-side filter: only the row with outcome=null is rendered.
      await waitFor(() => {
        const visibleIds = Array.from(
          screen.getAllByTestId('data-table-row'),
        ).map((row) =>
          // The row's testid is from rowKey=recommendationId in the wrapper
          // -> not directly readable here; instead look at displayed product
          (row.textContent ?? '').replace(/\s+/g, ' '),
        );
        // Only LaunchKit (the pending row) should be in the table.
        expect(visibleIds.some((t) => t.includes('LaunchKit'))).toBe(true);
        expect(visibleIds.every((t) => !t.includes('Synapz'))).toBe(true);
        expect(visibleIds.every((t) => !t.includes('ContentHelm'))).toBe(true);
      });
    });
  });

  describe('AC#5 — Cross-Epic deep-link from HUB-1607 (?productId=)', () => {
    it('URL ?productId=p-2 seeds the product filter on mount and requests it', async () => {
      renderPage('/console/plan-advisor?productId=p-2');
      await waitFor(() => {
        const call = lastListCall();
        expect(call?.search.get('productId')).toBe('p-2');
      });
      const filter = screen.getByTestId(
        'plan-advisor-product-filter',
      ) as HTMLSelectElement;
      expect(filter.value).toBe('p-2');
    });

    it('deep-linked productId NOT in the portfolio dropdown surfaces as a fallback option', async () => {
      renderPage('/console/plan-advisor?productId=p-experimental');
      const filter = screen.getByTestId(
        'plan-advisor-product-filter',
      ) as HTMLSelectElement;
      await waitFor(() => {
        expect(filter.value).toBe('p-experimental');
      });
      const values = Array.from(filter.options).map((o) => o.value);
      expect(values).toContain('p-experimental');
    });
  });

  describe('AC#6/#7 — CTA buttons + row navigation', () => {
    it('"New Recommendation" CTA navigates to /console/plan-advisor/new', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-advisor-new-cta'),
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('plan-advisor-new-cta'));
      await waitFor(() => {
        expect(screen.getByTestId('path').textContent).toContain(
          '/console/plan-advisor/new',
        );
      });
    });

    it('row click navigates to /console/plan-advisor/:runId', async () => {
      renderPage();
      await waitFor(() => {
        // Synapz appears in both the table AND the product filter dropdown;
        // assert on the data-table row presence directly instead.
        expect(screen.getAllByTestId('data-table-row').length).toBeGreaterThan(0);
      });
      const rows = screen.getAllByTestId('data-table-row');
      const synapzRow = rows.find((r) =>
        Array.from(r.querySelectorAll('td')).some(
          (td) => td.textContent === 'Synapz',
        ),
      );
      expect(synapzRow).toBeDefined();
      fireEvent.click(synapzRow!);
      await waitFor(() => {
        expect(screen.getByTestId('path').textContent).toContain(
          '/console/plan-advisor/r-1',
        );
      });
    });
  });

  describe('AC#8 — empty state', () => {
    it('renders the spec empty copy + primary CTA when there are no rows', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [], total: 0 });
        }
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        return Promise.reject(new Error(`unexpected: ${path}`));
      });
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-advisor-empty-state'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByText(/no recommendations yet/i),
      ).toBeInTheDocument();
      // Empty-state CTA also navigates to the new flow.
      fireEvent.click(screen.getByTestId('plan-advisor-empty-cta'));
      await waitFor(() => {
        expect(screen.getByTestId('path').textContent).toContain(
          '/console/plan-advisor/new',
        );
      });
    });
  });

  describe('AC#9 — loading state', () => {
    it('renders the DataTable skeleton while the fetch is in flight', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderPage();
      expect(
        screen.getAllByTestId('data-table-skeleton-row').length,
      ).toBeGreaterThan(0);
    });
  });

  describe('AC#10 — error state with Retry', () => {
    it('error banner renders + Retry refires the fetch', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      let firstCall = true;
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          if (firstCall) {
            firstCall = false;
            return Promise.reject(new Error('upstream down'));
          }
          return Promise.resolve(LIST_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-advisor-error-banner'),
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      await waitFor(() => {
        // Synapz appears in both the table AND the product filter dropdown;
        // assert on the data-table row presence directly instead.
        expect(screen.getAllByTestId('data-table-row').length).toBeGreaterThan(0);
      });
      errSpy.mockRestore();
    });
  });

  describe('HUB-1642 preview — denial UX on 403', () => {
    it('PermissionDeniedError renders <AccessDeniedPage> with back-link to dashboard', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.reject(
            new PermissionDeniedError(403, 'Forbidden'),
          );
        }
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('access-denied-page'),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('plan-advisor-error-banner'),
      ).toBeNull();
      expect(
        screen.getByTestId('access-denied-back-link'),
      ).toHaveAttribute('href', '/console/dashboard');
      errSpy.mockRestore();
    });
  });

  describe('document.title management', () => {
    it('sets title to "Plan Advisor | HUB Console" on mount', () => {
      const original = document.title;
      try {
        renderPage();
        expect(document.title).toBe('Plan Advisor | HUB Console');
      } finally {
        document.title = original;
      }
    });

    it('restores previous title on unmount', () => {
      const original = document.title;
      try {
        document.title = 'Before';
        const { unmount } = renderPage();
        expect(document.title).toBe('Plan Advisor | HUB Console');
        unmount();
        expect(document.title).toBe('Before');
      } finally {
        document.title = original;
      }
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with rows loaded', async () => {
      const { container } = renderPage();
      await waitFor(() => {
        // Synapz appears in both the table AND the product filter dropdown;
        // assert on the data-table row presence directly instead.
        expect(screen.getAllByTestId('data-table-row').length).toBeGreaterThan(0);
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the empty state', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [], total: 0 });
        }
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        return Promise.reject(new Error('unexpected'));
      });
      const { container } = renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-advisor-empty-state'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
