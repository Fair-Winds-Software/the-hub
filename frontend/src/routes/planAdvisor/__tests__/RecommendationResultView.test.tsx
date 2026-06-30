// Authorized by HUB-1640 (E-FE-4 S4) — RecommendationResultView tests. Covers
// loading skeletons, advisory warning banner prominence (above the header
// + role=alert + verbatim copy + icon), header (product name + timestamp +
// operator), PlanComparison wiring with reasoning bullets, impact summary
// MRR color branches + churn-risk placeholder, stale banner > 30d, error
// banner + back link, 404 not-found + back link, denial UX, document.title,
// and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import RecommendationResultView from '../RecommendationResultView';
import { PermissionDeniedError } from '../../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

function row(over: Partial<Parameters<typeof Object.assign>[1]> = {}) {
  return {
    recommendationId: 'r-1',
    productId: 'p-1',
    tenantId: 't-1',
    productName: 'Synapz',
    currentPlan: null,
    recommendedPlan: 'Pro',
    reasoning: 'Usage exceeds standard tier\nVariable usage pattern',
    mrrImpact: 50,
    outcome: null as string | null,
    outcomeNote: null,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    outcomeCapturedAt: null,
    operatorEmail: null,
    ...over,
  };
}

function defaultMock(rows = [row()]) {
  return (path: string) => {
    if (path.startsWith('/api/v1/admin/advisor/recommendations')) {
      return Promise.resolve({ data: rows, total: rows.length });
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

function renderPage(runId = 'r-1') {
  return render(
    <MemoryRouter initialEntries={[`/console/plan-advisor/${runId}`]}>
      <Routes>
        <Route
          path="/console/plan-advisor/:runId"
          element={<RecommendationResultView />}
        />
        <Route
          path="/console/plan-advisor"
          element={<div data-testid="advisor-list" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RecommendationResultView (HUB-1640)', () => {
  describe('AC#9 — loading state', () => {
    it('renders the advisory banner + header skeleton + comparison skeleton', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderPage();
      // Advisory banner shows even in loading state per AC#2 prominence.
      expect(screen.getByTestId('advisory-warning-banner')).toBeInTheDocument();
      expect(
        screen.getByTestId('recommendation-header-skeleton'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('recommendation-comparison-skeleton'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2 — advisory warning banner (FR-006 verbatim, AC-E3 prominence)', () => {
    it('renders the warning with role=alert + icon + the verbatim spec copy', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-product-heading'),
        ).toBeInTheDocument();
      });
      const banner = screen.getByTestId('advisory-warning-banner');
      expect(banner).toHaveAttribute('role', 'alert');
      expect(
        screen.getByTestId('advisory-warning-icon'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('advisory-warning-text').textContent,
      ).toBe(
        'Advisory only — never auto-applied. To apply, edit the plan manually.',
      );
    });

    it('AC-E3 prominence: banner is the first focusable child of the page (above the product header)', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-product-heading'),
        ).toBeInTheDocument();
      });
      const page = screen.getByTestId('recommendation-result-page');
      const banner = screen.getByTestId('advisory-warning-banner');
      const heading = screen.getByTestId('recommendation-product-heading');
      // Banner's index in the page's flow must be less than the heading's.
      const children = Array.from(page.children);
      const bannerIdx = children.indexOf(banner);
      // Heading is nested inside <header>; its position is the header element.
      const headerEl = heading.closest('header')!;
      const headerIdx = children.indexOf(headerEl);
      expect(bannerIdx).toBeGreaterThanOrEqual(0);
      expect(bannerIdx).toBeLessThan(headerIdx);
    });
  });

  describe('AC#3 — header (product + timestamp + operator)', () => {
    it('renders product name as <h1>; timestamp; operator as "—" per spec deviation #2', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-product-heading').textContent,
        ).toBe('Synapz');
      });
      expect(
        screen.getByTestId('recommendation-timestamp'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('recommendation-operator').textContent,
      ).toBe('—');
    });
  });

  describe('AC#4 — PlanComparison wiring', () => {
    it('renders PlanComparison with current=null placeholder + reasoning bullets parsed from \\n', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-comparison'),
        ).toBeInTheDocument();
      });
      // currentPlan is null → left card shows the "No current plan" placeholder.
      expect(
        screen.getByTestId('plan-card-left-empty'),
      ).toBeInTheDocument();
      // Right card shows the recommended plan title.
      expect(
        screen.getByTestId('plan-card-right-title').textContent,
      ).toBe('Pro');
      // Reasoning bullets parsed line-by-line.
      const reasoning = screen.getByTestId('plan-comparison-reasoning');
      const items = reasoning.querySelectorAll('li');
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toMatch(/exceeds standard tier/);
    });

    it('omits the reasoning section when the BE returns an empty reasoning string', async () => {
      apiGetMock.mockImplementation(defaultMock([row({ reasoning: '' })]));
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-comparison'),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('plan-comparison-reasoning'),
      ).toBeNull();
    });
  });

  describe('AC#5 — impact summary', () => {
    it('positive mrrImpact renders with seafoam color and /mo suffix', async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('impact-mrr-value')).toBeInTheDocument();
      });
      const v = screen.getByTestId('impact-mrr-value');
      expect(v.textContent).toMatch(/\+\$50\/mo/);
      expect(v.className).toMatch(/seafoam/);
    });

    it('negative mrrImpact renders with ironwake color', async () => {
      apiGetMock.mockImplementation(defaultMock([row({ mrrImpact: -25 })]));
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('impact-mrr-value')).toBeInTheDocument();
      });
      const v = screen.getByTestId('impact-mrr-value');
      expect(v.textContent).toMatch(/−\$25\/mo|-\$25\/mo|\(\$25\)/);
      expect(v.className).toMatch(/ironwake/);
    });

    it('null mrrImpact renders em-dash with neutral color', async () => {
      apiGetMock.mockImplementation(defaultMock([row({ mrrImpact: null })]));
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('impact-mrr-value').textContent).toBe('—');
      });
    });

    it('churn-risk renders em-dash with a tooltip explaining the BE caveat', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('impact-churn-risk-value'),
        ).toBeInTheDocument();
      });
      const v = screen.getByTestId('impact-churn-risk-value');
      expect(v.textContent).toBe('—');
      expect(v.getAttribute('title')).toMatch(/churn risk/i);
    });
  });

  describe('AC#6 — stale detection (> 30 days)', () => {
    it('createdAt within 30 days does NOT render the stale banner', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('plan-comparison'),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('stale-recommendation-banner'),
      ).toBeNull();
    });

    it('createdAt > 30 days ago renders the stale banner with age', async () => {
      apiGetMock.mockImplementation(
        defaultMock([
          row({
            createdAt: new Date(
              Date.now() - 60 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          }),
        ]),
      );
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('stale-recommendation-banner'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('stale-recommendation-banner').textContent,
      ).toMatch(/60 days/);
    });
  });

  describe('AC#7 — outcome capture placeholder for S5', () => {
    it('renders the outcome capture section placeholder for HUB-1641 (S5)', async () => {
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('outcome-capture-placeholder'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('AC#10 — error state with back link', () => {
    it('non-404 fetch failure renders the error banner + Back to advisor list link', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockImplementation(() =>
        Promise.reject(new Error('upstream timeout')),
      );
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-error-banner'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('recommendation-error-banner').textContent,
      ).toContain('upstream timeout');
      expect(
        screen.getByRole('link', { name: /back to advisor list/i }),
      ).toHaveAttribute('href', '/console/plan-advisor');
      errSpy.mockRestore();
    });

    it('404 from the list endpoint renders the not-found state', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockImplementation(() =>
        Promise.reject(new Error('Request failed: 404')),
      );
      renderPage('r-bogus');
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-not-found'),
        ).toBeInTheDocument();
      });
      errSpy.mockRestore();
    });

    it('list returns 200 but the recommendationId is missing → not-found', async () => {
      apiGetMock.mockImplementation(defaultMock([row({ recommendationId: 'r-other' })]));
      renderPage('r-1');
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-not-found'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('HUB-1642 preview — denial UX on 403', () => {
    it('PermissionDeniedError renders <AccessDeniedPage> with back-link to advisor list', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockImplementation(() =>
        Promise.reject(new PermissionDeniedError(403, 'Forbidden')),
      );
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('access-denied-page'),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('recommendation-error-banner'),
      ).toBeNull();
      expect(
        screen.getByTestId('access-denied-back-link'),
      ).toHaveAttribute('href', '/console/plan-advisor');
      errSpy.mockRestore();
    });
  });

  describe('AC#11 — document.title management', () => {
    it('sets title to "Recommendation for <Product> | Plan Advisor | HUB Console" once loaded', async () => {
      const original = document.title;
      try {
        renderPage();
        await waitFor(() => {
          expect(document.title).toBe(
            'Recommendation for Synapz | Plan Advisor | HUB Console',
          );
        });
      } finally {
        document.title = original;
      }
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with the ready state', async () => {
      const { container } = renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-product-heading'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the not-found state', async () => {
      apiGetMock.mockImplementation(defaultMock([]));
      const { container } = renderPage();
      await waitFor(() => {
        expect(
          screen.getByTestId('recommendation-not-found'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
