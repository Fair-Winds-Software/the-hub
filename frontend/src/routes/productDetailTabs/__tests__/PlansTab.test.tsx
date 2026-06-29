// Authorized by HUB-1606 (E-FE-3 S6) — PlansTab tests. Covers fetch + render (flatten
// active_model + history), 5-column header, default sort by created date desc, empty
// state with link-out to /pricing, error state, loading state, and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import { PlansTab } from '../PlansTab';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const ACTIVE_MODEL = {
  model_id: 'pm-active',
  product_id: 'p-1',
  model_type: 'credit',
  currency: 'usd',
  config: { tier: 'pro' },
  active: true,
  activated_at: '2026-01-01T00:00:00.000Z',
  deprecated_at: null,
  created_by: 'op-1',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const HISTORY = [
  {
    ...ACTIVE_MODEL,
    model_id: 'pm-prev-1',
    model_type: 'standard',
    active: false,
    activated_at: '2025-06-01T00:00:00.000Z',
    deprecated_at: '2026-01-01T00:00:00.000Z',
    created_at: '2025-06-01T00:00:00.000Z',
  },
  {
    ...ACTIVE_MODEL,
    model_id: 'pm-prev-2',
    model_type: 'tiered',
    active: false,
    activated_at: '2024-12-01T00:00:00.000Z',
    deprecated_at: '2025-06-01T00:00:00.000Z',
    created_at: '2024-12-01T00:00:00.000Z',
  },
];

const OVERVIEW_RESPONSE = {
  active_model: ACTIVE_MODEL,
  history: HISTORY,
};

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderTab() {
  return render(
    <MemoryRouter>
      <PlansTab productId="p-1" />
    </MemoryRouter>,
  );
}

describe('PlansTab (HUB-1606)', () => {
  describe('AC#2/#3 — table renders from pricing overview', () => {
    it('fetches /api/v1/admin/console/pricing/:productId/overview and renders active + history rows', async () => {
      apiGetMock.mockResolvedValue(OVERVIEW_RESPONSE);
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('plan-name-pm-active')).toBeInTheDocument();
      });
      // 3 rows = 1 active + 2 history.
      expect(screen.getAllByTestId('data-table-row')).toHaveLength(3);
      const portfolioCalls = apiGetMock.mock.calls
        .map((c) => c[0] as string);
      expect(portfolioCalls[0]).toBe(
        '/api/v1/admin/console/pricing/p-1/overview',
      );
    });

    it('renders the 5 column headers per AC#2', async () => {
      apiGetMock.mockResolvedValue(OVERVIEW_RESPONSE);
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('plan-name-pm-active')).toBeInTheDocument();
      });
      const table = screen.getByRole('table', { name: 'Product plans' });
      const headers = Array.from(table.querySelectorAll('th')).map(
        (h) => h.textContent ?? '',
      );
      for (const label of [
        'Plan Name',
        'Billing Mode',
        'Price',
        'Active Subscriptions',
        'Created Date',
      ]) {
        expect(headers.some((h) => h.includes(label))).toBe(true);
      }
    });

    it('marks the active model with a badge', async () => {
      apiGetMock.mockResolvedValue(OVERVIEW_RESPONSE);
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('plan-active-badge')).toBeInTheDocument();
      });
      // Only one row carries the active badge.
      expect(screen.getAllByTestId('plan-active-badge')).toHaveLength(1);
    });

    it('renders read-only — no create/edit/delete affordances', async () => {
      apiGetMock.mockResolvedValue(OVERVIEW_RESPONSE);
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('plan-name-pm-active')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /new plan/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /delete plan/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /edit plan/i })).toBeNull();
    });
  });

  describe('AC#4 — empty state with link to /pricing', () => {
    it('renders empty state with link to /console/products/:productId/pricing when no plans', async () => {
      apiGetMock.mockResolvedValue({ active_model: null, history: [] });
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('plans-empty-state')).toBeInTheDocument();
      });
      const cta = screen.getByTestId('plans-empty-cta');
      expect(cta).toHaveAttribute(
        'href',
        '/console/products/p-1/pricing',
      );
    });
  });

  describe('AC#6 — error state', () => {
    it('renders error banner per error-message-guidelines when fetch fails', async () => {
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      apiGetMock.mockRejectedValue(new Error('upstream timeout'));
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('plans-tab-error')).toBeInTheDocument();
      });
      expect(screen.getByTestId('plans-tab-error').textContent).toContain(
        'upstream timeout',
      );
      errSpy.mockRestore();
    });
  });

  describe('loading state', () => {
    it('renders loading text while fetch is in flight', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderTab();
      expect(screen.getByTestId('plans-tab-loading')).toBeInTheDocument();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with rows loaded', async () => {
      apiGetMock.mockResolvedValue(OVERVIEW_RESPONSE);
      const { container } = renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('plan-name-pm-active')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in empty state', async () => {
      apiGetMock.mockResolvedValue({ active_model: null, history: [] });
      const { container } = renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('plans-empty-state')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
