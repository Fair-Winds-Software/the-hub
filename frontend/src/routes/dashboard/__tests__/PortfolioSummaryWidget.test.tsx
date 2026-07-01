// Authorized by HUB-1645 (E-FE-2 S2) — PortfolioSummaryWidget tests. Covers
// tile row (Total MRR sum, Open Recommendations verdict, Products Under Watch
// verdict), losing-money banner triple-encoding + role=alert + margin
// formatting, silent degrade when the /portfolio-margin endpoint 404s, error
// state + retry, loading skeleton, and axe-core zero violations.
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
import { PortfolioSummaryWidget } from '../PortfolioSummaryWidget';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const BASE_SUMMARY = {
  total_products: 3,
  open_recommendations: 2,
  upgrade_count: 1,
  downgrade_count: 1,
  switch_to_annual_count: 0,
  stay_count: 0,
  high_confidence_count: 1,
  product_cards: [
    {
      product_id: 'p-1',
      product_name: 'Synapz',
      active_tenants: 10,
      mrr_cents: 500_00,
      open_recommendation_count: 1,
      health_badge: 'green',
    },
    {
      product_id: 'p-2',
      product_name: 'ContentHelm',
      active_tenants: 5,
      mrr_cents: 250_00,
      open_recommendation_count: 1,
      health_badge: 'amber',
    },
    {
      product_id: 'p-3',
      product_name: 'LegacyApp',
      active_tenants: 2,
      mrr_cents: 100_00,
      open_recommendation_count: 0,
      health_badge: 'red',
    },
  ],
  churn_risk: [
    { tenant_id: 't-1', product_id: 'p-2' },
  ],
  margin_health: [
    { discount_id: 'd-1', product_id: 'p-3' },
    { discount_id: 'd-2', product_id: 'p-3' },
  ],
};

function mockSummary(overrides: Partial<typeof BASE_SUMMARY> = {}) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
      return Promise.resolve({ ...BASE_SUMMARY, ...overrides });
    }
    // Default: no margin endpoint (HUB-1556 not yet built).
    return Promise.reject(new Error('unavailable'));
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('PortfolioSummaryWidget (HUB-1645)', () => {
  describe('AC#1 — MetricTile row (Total MRR sum + Open Recs verdict + Under Watch verdict)', () => {
    it('renders three tiles once the summary loads', async () => {
      mockSummary();
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      // Three tiles rendered.
      expect(screen.getAllByTestId('metric-tile')).toHaveLength(3);
    });

    it('Total MRR is the sum of product_cards.mrr_cents formatted as USD', async () => {
      mockSummary();
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      const values = screen.getAllByTestId('metric-tile-value');
      // Sum: 500 + 250 + 100 = $850.
      expect(values[0].textContent).toMatch(/\$850/);
    });

    it('Open Recommendations = 0 → success verdict; > 0 → warning', async () => {
      mockSummary();
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      // BASE has 2 open recs → warning verdict.
      const warningTiles = screen.getAllByTestId(
        'metric-tile-verdict-warning',
      );
      expect(warningTiles.length).toBeGreaterThan(0);
    });

    it('Products Under Watch counts unique products across margin_health + churn_risk', async () => {
      mockSummary();
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      // BASE has margin={p-3, p-3} + churn={p-2} → unique products = 2.
      const values = screen.getAllByTestId('metric-tile-value');
      expect(values[2].textContent).toBe('2');
    });

    it('empty portfolio → all-zero tiles + success verdicts', async () => {
      mockSummary({
        open_recommendations: 0,
        upgrade_count: 0,
        downgrade_count: 0,
        product_cards: [],
        churn_risk: [],
        margin_health: [],
      });
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      const successTiles = screen.getAllByTestId(
        'metric-tile-verdict-success',
      );
      // Open Recs + Under Watch both success (Total MRR stays neutral).
      expect(successTiles.length).toBe(2);
    });
  });

  describe('AC#2 — losing-money banner (triple-encoded + role=alert + aria-live)', () => {
    it('does NOT render when the margin endpoint is unavailable', async () => {
      mockSummary();
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('losing-money-banner'),
      ).toBeNull();
    });

    it('renders + announces when portfolio.losingMoney is true', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
          return Promise.resolve(BASE_SUMMARY);
        }
        if (path.startsWith('/api/v1/admin/analytics/portfolio-margin')) {
          return Promise.resolve({
            portfolio: { losingMoney: true, marginPct: -3.75 },
          });
        }
        return Promise.reject(new Error('unexpected'));
      });
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('losing-money-banner'),
        ).toBeInTheDocument();
      });
      const banner = screen.getByTestId('losing-money-banner');
      expect(banner).toHaveAttribute('role', 'alert');
      expect(banner).toHaveAttribute('aria-live', 'polite');
      // Triple-encoded: color (CSS class) + icon + text.
      expect(screen.getByTestId('losing-money-icon')).toBeInTheDocument();
      expect(
        screen.getByTestId('losing-money-margin-pct').textContent,
      ).toBe('-3.8%');
    });

    it('does NOT render when losingMoney is false (positive margin)', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
          return Promise.resolve(BASE_SUMMARY);
        }
        if (path.startsWith('/api/v1/admin/analytics/portfolio-margin')) {
          return Promise.resolve({
            portfolio: { losingMoney: false, marginPct: 12.5 },
          });
        }
        return Promise.reject(new Error('unexpected'));
      });
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('losing-money-banner'),
      ).toBeNull();
    });
  });

  describe('AC#3 — loading skeleton + error state + retry', () => {
    it('renders the matching-dimension tile skeleton before data arrives', () => {
      // Pending promise — never resolves.
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      render(<PortfolioSummaryWidget />);
      expect(
        screen.getByTestId('portfolio-summary-widget-tiles-skeleton'),
      ).toBeInTheDocument();
      expect(
        screen.getAllByTestId('metric-tile-skeleton'),
      ).toHaveLength(3);
    });

    it('renders error banner with retry button; retry re-fetches', async () => {
      let call = 0;
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
          call++;
          if (call === 1) return Promise.reject(new Error('boom'));
          return Promise.resolve(BASE_SUMMARY);
        }
        return Promise.reject(new Error('unavailable'));
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        render(<PortfolioSummaryWidget />);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-error'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('portfolio-summary-widget-error').textContent,
      ).toMatch(/boom/);
      await act(async () => {
        fireEvent.click(
          screen.getByTestId('portfolio-summary-widget-retry'),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      errSpy.mockRestore();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan in the ready state', async () => {
      mockSummary();
      const { container } = render(<PortfolioSummaryWidget />);
      await waitFor(() => {
        expect(
          screen.getByTestId('portfolio-summary-widget-tiles'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan when the losing-money banner is rendered', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/advisor/portfolio/summary')) {
          return Promise.resolve(BASE_SUMMARY);
        }
        if (path.startsWith('/api/v1/admin/analytics/portfolio-margin')) {
          return Promise.resolve({
            portfolio: { losingMoney: true, marginPct: -3.75 },
          });
        }
        return Promise.reject(new Error('unexpected'));
      });
      const { container } = render(<PortfolioSummaryWidget />);
      await waitFor(() => {
        expect(
          screen.getByTestId('losing-money-banner'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
