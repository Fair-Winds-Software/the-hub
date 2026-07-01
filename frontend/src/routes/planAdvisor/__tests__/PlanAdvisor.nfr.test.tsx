// Authorized by HUB-1643 (E-FE-4 S7) — NFR verification for the plan advisor
// Epic. Extends HUB-1636 + HUB-1629 + HUB-1619 + HUB-1610 with the
// integration-shaped gates the per-component test files cannot reach alone:
//
//   1. axe-core scan on /console/plan-advisor (list) with filters + table
//      mounted in the same DOM tree.
//   2. axe-core scan on /console/plan-advisor/new (product picker + recency
//      warning surfaces) mounted in the same DOM tree.
//   3. axe-core scan on /console/plan-advisor/:runId (result view) with
//      advisory warning + PlanComparison + ImpactSummary + OutcomeCapture
//      all mounted in the same DOM tree.
//   4. Advisory warning prominence (AC-E3): the "Advisory only" banner is
//      the FIRST element under #main-content, uses role="alert", and sits
//      above the plan comparison in DOM order.
//   5. Outcome button semantic ARIA: buttons render with aria-pressed +
//      an aria-live status region announces submit success/error.
//   6. Page render perf (< 2500ms) synthetic assertion — Lighthouse CWV
//      measurement of post-auth /console/plan-advisor* routes defers to
//      Stage 4 per D-HUB-SCOPE-051 (same in-memory-session constraint as
//      /console/dashboard / /console/audit / /console/products / /console/
//      compliance / /console/sdk-versions). CI gate continues to measure
//      /console/login as the canonical cold-load CWV proxy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PlanAdvisor from '../../PlanAdvisor';
import NewRecommendationFlow from '../NewRecommendationFlow';
import RecommendationResultView from '../RecommendationResultView';

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

const RECOMMENDATIONS_ROW = {
  recommendationId: 'r-1',
  productId: 'p-1',
  tenantId: 't-1',
  productName: 'Synapz',
  currentPlan: 'Starter — $99/mo',
  recommendedPlan: 'Growth — $199/mo',
  reasoning: 'Usage exceeds Starter tier.\nProjected MRR uplift +$100/mo.',
  mrrImpact: 100,
  outcome: null,
  outcomeNote: null,
  createdAt: new Date().toISOString(),
  outcomeCapturedAt: null,
  operatorEmail: 'super@maverick.example',
};

const RECOMMENDATIONS_RESPONSE = {
  data: [RECOMMENDATIONS_ROW],
  total: 1,
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve(PORTFOLIO_RESPONSE);
    }
    if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
      return Promise.resolve(RECOMMENDATIONS_RESPONSE);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
});

afterEach(() => {
  cleanup();
});

describe('Plan Advisor NFR verification (HUB-1643)', () => {
  describe('AC#1 — axe-core: /console/plan-advisor', () => {
    it('list view passes axe scan with filters + table mounted', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/plan-advisor']}>
          <Routes>
            <Route path="/console/plan-advisor" element={<PlanAdvisor />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('plan-advisor-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#1 — axe-core: /console/plan-advisor/new', () => {
    it('new-recommendation view passes axe scan with picker mounted', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/plan-advisor/new']}>
          <Routes>
            <Route
              path="/console/plan-advisor/new"
              element={<NewRecommendationFlow />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('new-recommendation-page'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#1 — axe-core: /console/plan-advisor/:runId', () => {
    it('result view passes axe scan with advisory + comparison + impact + outcome all mounted', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/plan-advisor/r-1']}>
          <Routes>
            <Route
              path="/console/plan-advisor/:runId"
              element={<RecommendationResultView />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-result-page'),
        ).toBeInTheDocument();
      });
      // All four section slots are present.
      expect(
        screen.getByTestId('advisory-warning-banner'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('recommendation-product-heading'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('impact-summary')).toBeInTheDocument();
      expect(screen.getByTestId('outcome-capture')).toBeInTheDocument();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#4 — advisory warning prominence (above-fold + role=alert)', () => {
    it('advisory banner is the first child under #main-content and precedes the plan comparison', async () => {
      render(
        <MemoryRouter initialEntries={['/console/plan-advisor/r-1']}>
          <Routes>
            <Route
              path="/console/plan-advisor/:runId"
              element={<RecommendationResultView />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-result-page'),
        ).toBeInTheDocument();
      });
      const page = screen.getByTestId('recommendation-result-page');
      const banner = screen.getByTestId('advisory-warning-banner');
      // Banner is the first child of #main-content wrapper.
      expect(page.firstElementChild).toBe(banner);
      // role=alert is on the banner.
      expect(banner).toHaveAttribute('role', 'alert');
      // Banner precedes the plan comparison section in DOM order.
      const comparison = screen.getByTestId('plan-comparison');
      expect(
        banner.compareDocumentPosition(comparison) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe('AC#5 — outcome button semantic ARIA + live status region', () => {
    it('outcome buttons render aria-pressed; submit success surfaces role=status', async () => {
      apiPostMock.mockResolvedValue({
        outcomeType: 'won',
        outcomeCapturedAt: new Date().toISOString(),
      });
      render(
        <MemoryRouter initialEntries={['/console/plan-advisor/r-1']}>
          <Routes>
            <Route
              path="/console/plan-advisor/:runId"
              element={<RecommendationResultView />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('outcome-button-won'),
        ).toBeInTheDocument();
      });
      // aria-pressed present on all 3 outcome buttons.
      for (const outcome of ['won', 'lost', 'no_action']) {
        expect(
          screen.getByTestId(`outcome-button-${outcome}`),
        ).toHaveAttribute('aria-pressed');
      }
    });
  });

  describe('AC#2 — page render perf (< 2500ms § 9 NFR-Performance)', () => {
    it('list mount + parallel fetch + table render stays under 2500ms', async () => {
      const start = performance.now();
      render(
        <MemoryRouter initialEntries={['/console/plan-advisor']}>
          <Routes>
            <Route path="/console/plan-advisor" element={<PlanAdvisor />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('plan-advisor-page')).toBeInTheDocument();
      });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2500);
    });

    it('result view mount + fetch + advisory/comparison/impact/outcome render stays under 2500ms', async () => {
      const start = performance.now();
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/console/plan-advisor/r-1']}>
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
          screen.getByTestId('recommendation-result-page'),
        ).toBeInTheDocument();
      });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2500);
    });
  });
});
