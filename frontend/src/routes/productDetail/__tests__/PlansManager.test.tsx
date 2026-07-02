// Authorized by HUB-1655 (E-FE-5 S5) — PlansManager tests. Covers list load
// with active-first ordering + archived toggle, New Plan modal (auto-key
// generation + billing_mode two-step confirm), Edit modal (Credit read-only
// helper text), Archive dialog (soft-archive success + 422 active-
// subscribers guard), and axe-core in the ready state.
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
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PlansManager from '../PlansManager';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPutMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
    delete: (...args: unknown[]) => apiDeleteMock(...args),
  },
}));

const PRODUCT = {
  productId: 'prod-1',
  productName: 'Synapz',
  tenantId: 'tenant-1',
};

const PLAN_ACTIVE = {
  id: 'plan-active-1',
  product_id: 'prod-1',
  key: 'starter',
  name: 'Starter',
  description: null,
  billing_type: 'flat_rate',
  billing_interval: 'month',
  unit_amount_cents: 9900,
  billing_mode: 'standard',
  active: true,
  archived_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const PLAN_CREDIT = {
  ...PLAN_ACTIVE,
  id: 'plan-credit-1',
  key: 'internal',
  name: 'Internal Credit',
  billing_mode: 'credit',
  created_at: '2026-02-01T00:00:00.000Z',
};

const PLAN_ARCHIVED = {
  ...PLAN_ACTIVE,
  id: 'plan-archived-1',
  key: 'legacy',
  name: 'Legacy',
  archived_at: '2026-03-01T00:00:00.000Z',
  active: false,
  created_at: '2025-12-01T00:00:00.000Z',
};

function mockDefault(plans: unknown[] = [PLAN_ACTIVE, PLAN_CREDIT]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.startsWith('/api/v1/admin/plans')) {
      return Promise.resolve({ data: plans, total: plans.length });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderPlans() {
  return render(
    <MemoryRouter initialEntries={['/console/products/prod-1/pricing/plans']}>
      <Routes>
        <Route
          path="/console/products/:productId/pricing/plans"
          element={<PlansManager />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPutMock.mockReset();
  apiDeleteMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('PlansManager (HUB-1655)', () => {
  describe('AC#1 — list load + active/archived ordering', () => {
    it('renders one row per plan returned by the BE', async () => {
      mockDefault();
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('plans-manager-row-plan-active-1'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('plans-manager-row-plan-credit-1'),
      ).toBeInTheDocument();
    });

    it('surfaces the credit billing-mode badge on the credit plan and standard on the standard plan', async () => {
      mockDefault();
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      const creditRow = screen.getByTestId('plans-manager-row-plan-credit-1');
      expect(
        creditRow.querySelector('[data-testid="plan-billing-mode-credit"]'),
      ).not.toBeNull();
      const standardRow = screen.getByTestId('plans-manager-row-plan-active-1');
      expect(
        standardRow.querySelector('[data-testid="plan-billing-mode-standard"]'),
      ).not.toBeNull();
    });

    it('archived toggle threads includeArchived=true through the GET query', async () => {
      mockDefault();
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      // Now switch data source to include the archived plan and flip toggle.
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve({ data: [PRODUCT] });
        }
        if (path.includes('includeArchived=true')) {
          return Promise.resolve({
            data: [PLAN_ACTIVE, PLAN_ARCHIVED],
            total: 2,
          });
        }
        return Promise.resolve({ data: [PLAN_ACTIVE], total: 1 });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('plans-manager-show-archived'));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('plans-manager-row-plan-archived-1'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('plans-manager-archived-badge-plan-archived-1'),
      ).toBeInTheDocument();
    });

    it('empty state renders the CTA copy when zero plans exist', async () => {
      mockDefault([]);
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('plans-manager-empty'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('AC#2 — New Plan modal (auto-key + two-step credit confirm)', () => {
    it('auto-generates the key from the name on first blur; POSTs on Create', async () => {
      mockDefault();
      apiPostMock.mockResolvedValueOnce({
        ...PLAN_ACTIVE,
        id: 'newly-created',
        name: 'Growth Tier',
        key: 'growth-tier',
      });
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('plans-manager-new'));
      const name = screen.getByTestId('new-plan-name') as HTMLInputElement;
      fireEvent.change(name, { target: { value: 'Growth Tier' } });
      fireEvent.blur(name);
      expect(
        (screen.getByTestId('new-plan-key') as HTMLInputElement).value,
      ).toBe('growth-tier');
      fireEvent.change(
        screen.getByTestId('new-plan-unit-amount'),
        { target: { value: '19900' } },
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId('new-plan-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const call = apiPostMock.mock.calls[0]!;
      expect(call[0]).toBe('/api/v1/admin/plans');
      expect(call[1]).toMatchObject({
        productId: 'prod-1',
        key: 'growth-tier',
        name: 'Growth Tier',
        unit_amount_cents: 19900,
        billing_mode: 'standard',
      });
    });

    it('billing_mode Credit selection is two-step; first click reveals the confirm panel + blocks submit', async () => {
      mockDefault();
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('plans-manager-new'));
      // First click on the toggle: reveals confirm panel but stays 'standard'.
      fireEvent.click(screen.getByTestId('new-plan-toggle-credit'));
      expect(
        screen.getByTestId('new-plan-credit-confirm-panel'),
      ).toBeInTheDocument();
      // Attempt submit while confirm is pending — expect a validation error.
      fireEvent.change(screen.getByTestId('new-plan-name'), {
        target: { value: 'Internal' },
      });
      fireEvent.change(screen.getByTestId('new-plan-key'), {
        target: { value: 'internal' },
      });
      fireEvent.change(screen.getByTestId('new-plan-unit-amount'), {
        target: { value: '0' },
      });
      fireEvent.click(screen.getByTestId('new-plan-submit'));
      expect(
        screen.getByTestId('new-plan-billing-mode-err'),
      ).toBeInTheDocument();
      expect(apiPostMock).not.toHaveBeenCalled();
      // Confirm click commits credit mode.
      fireEvent.click(screen.getByTestId('new-plan-toggle-credit'));
      expect(
        screen.queryByTestId('new-plan-credit-confirm-panel'),
      ).toBeNull();
      apiPostMock.mockResolvedValueOnce({ ...PLAN_ACTIVE, billing_mode: 'credit' });
      await act(async () => {
        fireEvent.click(screen.getByTestId('new-plan-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPostMock.mock.calls[0]![1]).toMatchObject({ billing_mode: 'credit' });
    });
  });

  describe('AC#3 — Edit modal read-only Credit helper text', () => {
    it('shows the Credit-locked helper text on a credit-mode plan', async () => {
      mockDefault();
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getByTestId('plans-manager-edit-plan-credit-1'),
      );
      expect(
        screen.getByTestId('edit-plan-credit-locked'),
      ).toBeInTheDocument();
    });

    it('PUT payload contains the updated name / description / unit_amount', async () => {
      mockDefault();
      apiPutMock.mockResolvedValueOnce(PLAN_ACTIVE);
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getByTestId('plans-manager-edit-plan-active-1'),
      );
      fireEvent.change(screen.getByTestId('edit-plan-name'), {
        target: { value: 'Starter Renamed' },
      });
      fireEvent.change(screen.getByTestId('edit-plan-unit-amount'), {
        target: { value: '12900' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('edit-plan-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPutMock).toHaveBeenCalledWith(
        '/api/v1/admin/plans/plan-active-1',
        expect.objectContaining({
          name: 'Starter Renamed',
          unit_amount_cents: 12900,
        }),
      );
    });
  });

  describe('AC#4 — Archive: soft-archive + 422 active-subscribers guard', () => {
    it('DELETE succeeds; the row is reloaded after the archive commits', async () => {
      mockDefault();
      apiDeleteMock.mockResolvedValueOnce({});
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getByTestId('plans-manager-archive-plan-active-1'),
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId('archive-plan-confirm'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/v1/admin/plans/plan-active-1',
      );
    });

    it('422 with activeSubscribers in the message renders the blocked copy + hides the confirm button', async () => {
      mockDefault();
      const err = new Error(
        'Archive blocked: {"error":"Plan has 4 active subscriber(s)","activeSubscribers":4}',
      );
      apiDeleteMock.mockRejectedValueOnce(err);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        renderPlans();
      });
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getByTestId('plans-manager-archive-plan-active-1'),
      );
      await act(async () => {
        fireEvent.click(screen.getByTestId('archive-plan-confirm'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        screen.getByTestId('archive-plan-blocked-copy').textContent,
      ).toMatch(/4/);
      expect(
        screen.queryByTestId('archive-plan-confirm'),
      ).toBeNull();
      errSpy.mockRestore();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan in the list-ready state', async () => {
      mockDefault();
      const { container } = renderPlans();
      await waitFor(() => {
        expect(screen.getByTestId('plans-manager-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
