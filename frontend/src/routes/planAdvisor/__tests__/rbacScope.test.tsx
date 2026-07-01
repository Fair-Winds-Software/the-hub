// Authorized by HUB-1642 (E-FE-4 S6) — RBAC scope wiring integration test.
// Simulates a product_admin operator whose server-side scope is ["product-A"]:
//
//   - PlanAdvisor list view product filter only surfaces product-A
//     (the /portfolio/products endpoint is server-authoritative and returns
//     only scoped products; the FE just renders what comes back).
//   - NewRecommendationFlow picker only surfaces product-A.
//   - URL-hack to a runId belonging to product-B raises the AccessDeniedPage
//     (PermissionDeniedError → result view denial state from S4).
//   - URL-hack to POST /run with an out-of-scope productId surfaces the
//     scope-denial inline banner (added in S6).
//
// AC#5 of HUB-1642: integration test for cross-component scope wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PlanAdvisor from '../../PlanAdvisor';
import NewRecommendationFlow from '../NewRecommendationFlow';
import RecommendationResultView from '../RecommendationResultView';
import { PermissionDeniedError } from '../../../lib/errors';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

// Simulated product_admin scope: only product-A. The /portfolio/products
// endpoint is server-scoped; this is the actual payload the operator's
// browser would see.
const SCOPED_PORTFOLIO = {
  data: [
    {
      productId: 'product-A',
      productName: 'Product A (in scope)',
      tenantId: 'tenant-1',
    },
  ],
  total: 1,
};

const EMPTY_LIST = { data: [], total: 0 };

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('HUB-1642 — RBAC scope wiring', () => {
  it('PlanAdvisor product filter only renders scoped products', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve(SCOPED_PORTFOLIO);
      }
      if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
        return Promise.resolve(EMPTY_LIST);
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/console/plan-advisor']}>
          <Routes>
            <Route path="/console/plan-advisor" element={<PlanAdvisor />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    const filter = await screen.findByTestId(
      'plan-advisor-product-filter',
    );
    await waitFor(() => {
      // "All products" + product-A only.
      expect(filter.querySelectorAll('option').length).toBe(2);
    });
    const labels = Array.from(
      filter.querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(labels).toContain('Product A (in scope)');
    expect(labels).not.toContain('Product B (out of scope)');
  });

  it('NewRecommendationFlow picker only renders scoped products', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve(SCOPED_PORTFOLIO);
      }
      if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
        return Promise.resolve(EMPTY_LIST);
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/console/plan-advisor/new']}>
          <Routes>
            <Route
              path="/console/plan-advisor/new"
              element={<NewRecommendationFlow />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });

    const picker = await screen.findByTestId(
      'new-recommendation-product-picker',
    );
    await waitFor(() => {
      // Placeholder + product-A only.
      expect(picker.querySelectorAll('option').length).toBe(2);
    });
    const labels = Array.from(
      picker.querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(labels).toContain('Product A (in scope)');
    expect(labels).not.toContain('Product B (out of scope)');
  });

  it('URL-hack POST /run with out-of-scope productId surfaces inline scope-denial banner', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve(SCOPED_PORTFOLIO);
      }
      if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
        return Promise.resolve(EMPTY_LIST);
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    // Simulate the server returning 403 even though the picker only
    // surfaces in-scope products (i.e. tamper / state-hack scenario).
    apiPostMock.mockRejectedValue(
      new PermissionDeniedError(403, 'Out of scope'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/console/plan-advisor/new']}>
          <Routes>
            <Route
              path="/console/plan-advisor/new"
              element={<NewRecommendationFlow />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });

    const picker = (await screen.findByTestId(
      'new-recommendation-product-picker',
    )) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'product-A' } });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('new-recommendation-run-button'),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByTestId('new-recommendation-scope-denied'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('new-recommendation-scope-denied-product').textContent,
    ).toBe('Product A (in scope)');
    errSpy.mockRestore();
  });

  it('URL-hack to out-of-scope runId renders AccessDeniedPage with back-to-advisor link', async () => {
    apiGetMock.mockRejectedValue(
      new PermissionDeniedError(403, 'Out of scope'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      render(
        <MemoryRouter
          initialEntries={['/console/plan-advisor/out-of-scope-run-id']}
        >
          <Routes>
            <Route
              path="/console/plan-advisor/:runId"
              element={<RecommendationResultView />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('access-denied-page'),
      ).toBeInTheDocument();
    });
    const back = screen.getByTestId('access-denied-back-link');
    expect(back.getAttribute('href')).toBe('/console/plan-advisor');
    errSpy.mockRestore();
  });
});
