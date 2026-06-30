// Authorized by HUB-1639 (E-FE-4 S3) — NewRecommendationFlow tests. Covers
// product picker population, recency check (within 7d → warning; older →
// no warning; failure → silent), Run Advisor success path navigation,
// Run anyway uses the same POST, error inline, Back to Plan Advisor link,
// cancel-warning state reset, products-fetch error banner, and axe-core.
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
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import NewRecommendationFlow from '../NewRecommendationFlow';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const PORTFOLIO_RESPONSE = {
  data: [
    { productId: 'p-1', productName: 'Synapz', tenantId: 't-1' },
    { productId: 'p-2', productName: 'ContentHelm', tenantId: 't-1' },
  ],
  total: 2,
};

function recentRow(daysAgo: number) {
  const t = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  return {
    recommendationId: 'r-recent',
    createdAt: new Date(t).toISOString(),
  };
}

function PathProbe() {
  const loc = useLocation();
  return <span data-testid="path">{loc.pathname}</span>;
}

function renderFlow(initialUrl = '/console/plan-advisor/new') {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route
          path="/console/plan-advisor/new"
          element={<NewRecommendationFlow />}
        />
        <Route path="/console/plan-advisor" element={<PathProbe />} />
        <Route
          path="/console/plan-advisor/:runId"
          element={<PathProbe />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('NewRecommendationFlow (HUB-1639)', () => {
  describe('AC#2 — product picker populated from portfolio', () => {
    it('renders the picker + Back to Plan Advisor link on mount', async () => {
      apiGetMock.mockResolvedValue(PORTFOLIO_RESPONSE);
      renderFlow();
      await waitFor(() => {
        const picker = screen.getByTestId(
          'new-recommendation-product-picker',
        ) as HTMLSelectElement;
        expect(
          Array.from(picker.options).map((o) => o.value),
        ).toEqual(expect.arrayContaining(['', 'p-1', 'p-2']));
      });
      expect(
        screen.getByTestId('new-recommendation-cancel-link'),
      ).toHaveAttribute('href', '/console/plan-advisor');
    });

    it('portfolio fetch failure renders the products-error banner', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockRejectedValue(new Error('portfolio down'));
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-products-error'),
        ).toBeInTheDocument();
      });
      errSpy.mockRestore();
    });
  });

  describe('AC#3 — recency check (within 7 days surfaces warning)', () => {
    it('warning banner appears with the latest run timestamp when within 7d', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [recentRow(2)], total: 1 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-rerun-warning'),
        ).toBeInTheDocument();
      });
    });

    it('no warning when latest run is older than 7 days', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [recentRow(14)], total: 1 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      // Give the recency check a chance to fire.
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-run-button'),
        ).not.toBeDisabled();
      });
      expect(
        screen.queryByTestId('new-recommendation-rerun-warning'),
      ).toBeNull();
    });

    it('recency check failure is silent (Run button still enabled)', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.reject(new Error('recency endpoint down'));
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      // No warning, no banner — just the run button enabled.
      expect(
        screen.queryByTestId('new-recommendation-rerun-warning'),
      ).toBeNull();
      expect(
        screen.getByTestId('new-recommendation-run-button'),
      ).not.toBeDisabled();
    });
  });

  describe('AC#9 — Cancel from warning resets the picker selection', () => {
    it('Cancel clears the selection (warning not remembered)', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [recentRow(2)], total: 1 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-rerun-warning'),
        ).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getByTestId('new-recommendation-cancel-warning'),
      );
      const picker = screen.getByTestId(
        'new-recommendation-product-picker',
      ) as HTMLSelectElement;
      expect(picker.value).toBe('');
      expect(
        screen.queryByTestId('new-recommendation-rerun-warning'),
      ).toBeNull();
    });
  });

  describe('AC#4/#6 — Run Advisor success path navigates to S4', () => {
    it('Run button POSTs to the path-param endpoint + navigates to /console/plan-advisor/:runId', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          // No prior runs — no warning.
          return Promise.resolve({ data: [], total: 0 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      apiPostMock.mockResolvedValue({ id: 'r-new' });
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(
          screen.getByTestId('new-recommendation-run-button'),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      // POST path encodes both productId + tenantId.
      expect(apiPostMock.mock.calls[0]?.[0]).toBe(
        '/api/v1/admin/advisor/p-1/t-1/run',
      );
      await waitFor(() => {
        expect(screen.getByTestId('path').textContent).toBe(
          '/console/plan-advisor/r-new',
        );
      });
    });

    it('Run anyway from the warning fires the same POST + navigation', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [recentRow(2)], total: 1 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      apiPostMock.mockResolvedValue({ id: 'r-rerun' });
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-rerun-warning'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(
          screen.getByTestId('new-recommendation-run-anyway'),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPostMock).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.getByTestId('path').textContent).toBe(
          '/console/plan-advisor/r-rerun',
        );
      });
    });

    it('Run-anyway button has aria-describedby pointing at the warning banner', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [recentRow(2)], total: 1 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-rerun-warning'),
        ).toBeInTheDocument();
      });
      const warning = screen.getByTestId('new-recommendation-rerun-warning');
      const runAnyway = screen.getByTestId(
        'new-recommendation-run-anyway',
      );
      expect(runAnyway).toHaveAttribute(
        'aria-describedby',
        warning.id,
      );
    });
  });

  describe('AC#5/#7 — loading + error states', () => {
    it('submit failure renders the inline error AND keeps operator on the picker', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [], total: 0 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      apiPostMock.mockRejectedValue(
        new Error('PLAN_NOT_FOUND: no active plan for product'),
      );
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(
          screen.getByTestId('new-recommendation-run-button'),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        screen.getByTestId('new-recommendation-submit-error').textContent,
      ).toContain('PLAN_NOT_FOUND');
      // Picker still mounted, page didn't navigate.
      expect(
        screen.getByTestId('new-recommendation-product-picker'),
      ).toBeInTheDocument();
      errSpy.mockRestore();
    });

    it('Run button label flips to "Running advisor…" while in flight', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [], total: 0 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      let resolve: (v: unknown) => void = () => {};
      apiPostMock.mockImplementation(
        () => new Promise((res) => { resolve = res; }),
      );
      renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(
          screen.getByTestId('new-recommendation-run-button'),
        );
        await Promise.resolve();
      });
      expect(
        screen.getByTestId('new-recommendation-run-button').textContent,
      ).toMatch(/Running advisor/i);
      expect(
        screen.getByTestId('new-recommendation-submitting'),
      ).toBeInTheDocument();
      // Resolve so cleanup doesn't hang on the pending promise.
      await act(async () => {
        resolve({ id: 'r-x' });
        await Promise.resolve();
      });
    });
  });

  describe('document.title management', () => {
    it('sets title to "New Recommendation | HUB Console" on mount', async () => {
      const original = document.title;
      try {
        apiGetMock.mockResolvedValue(PORTFOLIO_RESPONSE);
        renderFlow();
        expect(document.title).toBe('New Recommendation | HUB Console');
      } finally {
        document.title = original;
      }
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan in the idle picker state', async () => {
      apiGetMock.mockResolvedValue(PORTFOLIO_RESPONSE);
      const { container } = renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan with the warning banner shown', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PORTFOLIO_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
          return Promise.resolve({ data: [recentRow(2)], total: 1 });
        }
        return Promise.reject(new Error('unexpected'));
      });
      const { container } = renderFlow();
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-product-picker'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('new-recommendation-product-picker'),
          { target: { value: 'p-1' } },
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-rerun-warning'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
