// Authorized by HUB-1658 (E-FE-5 S8) — BillingFreezeControls tests. Covers
// default-active pill, freeze modal with ≥20-char reason floor + two-step
// confirm gating, POST payload shape, success toast + pill flip to frozen,
// unfreeze DELETE + pill flip back, 422 "already frozen" state correction,
// scope-denied path, and axe zero violations.
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
import BillingFreezeControls from '../BillingFreezeControls';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    delete: (...args: unknown[]) => apiDeleteMock(...args),
  },
}));

const PRODUCT = {
  productId: 'prod-1',
  productName: 'Synapz',
  tenantId: 'tenant-1',
};

function mockPortfolio(product = PRODUCT) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [product] });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderCtrl() {
  return render(
    <MemoryRouter initialEntries={['/console/products/prod-1/pricing/freeze']}>
      <Routes>
        <Route
          path="/console/products/:productId/pricing/freeze"
          element={<BillingFreezeControls />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const LONG_REASON = 'Customer requested billing pause pending SLA review 2026-07-01';

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('BillingFreezeControls (HUB-1658)', () => {
  it('defaults to the Active pill with a Freeze CTA on mount', async () => {
    mockPortfolio();
    await act(async () => {
      renderCtrl();
    });
    await waitFor(() => {
      expect(screen.getByTestId('freeze-page')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('freeze-status-pill-active'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('freeze-cta-freeze')).toBeInTheDocument();
    expect(screen.queryByTestId('freeze-cta-unfreeze')).toBeNull();
  });

  it('renders AccessDeniedPage when the operator is out of scope', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({ data: [] });
      }
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      renderCtrl();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('access-denied-page'),
      ).toBeInTheDocument();
    });
  });

  describe('Freeze flow', () => {
    it('confirm button stays disabled until the reason hits the 20-char floor', async () => {
      mockPortfolio();
      await act(async () => {
        renderCtrl();
      });
      await waitFor(() => {
        expect(screen.getByTestId('freeze-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('freeze-cta-freeze'));
      const confirm = screen.getByTestId('freeze-modal-confirm-freeze');
      expect(confirm.hasAttribute('disabled')).toBe(true);
      fireEvent.change(screen.getByTestId('freeze-modal-reason-freeze'), {
        target: { value: 'too short' },
      });
      expect(
        screen.getByTestId('freeze-modal-counter-freeze').textContent,
      ).toMatch(/9 \/ 20/);
      expect(confirm.hasAttribute('disabled')).toBe(true);
      fireEvent.change(screen.getByTestId('freeze-modal-reason-freeze'), {
        target: { value: LONG_REASON },
      });
      expect(confirm.hasAttribute('disabled')).toBe(false);
    });

    it('two-step: first confirm click reveals the confirm-panel; second click POSTs and flips the pill', async () => {
      mockPortfolio();
      apiPostMock.mockResolvedValueOnce({ frozen: true });
      await act(async () => {
        renderCtrl();
      });
      await waitFor(() => {
        expect(screen.getByTestId('freeze-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('freeze-cta-freeze'));
      fireEvent.change(screen.getByTestId('freeze-modal-reason-freeze'), {
        target: { value: LONG_REASON },
      });
      // First click on Confirm: reveals the confirm panel.
      fireEvent.click(screen.getByTestId('freeze-modal-confirm-freeze'));
      expect(
        screen.getByTestId('freeze-modal-confirm-panel-freeze'),
      ).toBeInTheDocument();
      expect(apiPostMock).not.toHaveBeenCalled();
      // Second click on Confirm: commits.
      await act(async () => {
        fireEvent.click(screen.getByTestId('freeze-modal-confirm-freeze'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/v1/admin/tenants/tenant-1/products/prod-1/freeze',
        { reason: LONG_REASON },
      );
      // Pill flipped to frozen; toast rendered.
      await waitFor(() => {
        expect(
          screen.getByTestId('freeze-status-pill-frozen'),
        ).toBeInTheDocument();
      });
      expect(screen.getByTestId('freeze-toast')).toBeInTheDocument();
      expect(screen.getByTestId('freeze-cta-unfreeze')).toBeInTheDocument();
    });

    it('422 "already suspended" flips the pill to frozen + closes the modal + refreshes toast', async () => {
      mockPortfolio();
      apiPostMock.mockRejectedValueOnce(new Error('License already suspended'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        renderCtrl();
      });
      await waitFor(() => {
        expect(screen.getByTestId('freeze-page')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('freeze-cta-freeze'));
      fireEvent.change(screen.getByTestId('freeze-modal-reason-freeze'), {
        target: { value: LONG_REASON },
      });
      // Skip past the two-step reveal by clicking twice.
      fireEvent.click(screen.getByTestId('freeze-modal-confirm-freeze'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('freeze-modal-confirm-freeze'));
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('freeze-status-pill-frozen'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('freeze-toast').textContent,
      ).toMatch(/already frozen/i);
      errSpy.mockRestore();
    });
  });

  describe('Unfreeze flow', () => {
    it('after a freeze, the Unfreeze CTA appears and DELETEs on confirm', async () => {
      mockPortfolio();
      apiPostMock.mockResolvedValueOnce({ frozen: true });
      apiDeleteMock.mockResolvedValueOnce({ frozen: false });
      await act(async () => {
        renderCtrl();
      });
      await waitFor(() => {
        expect(screen.getByTestId('freeze-page')).toBeInTheDocument();
      });
      // Freeze first.
      fireEvent.click(screen.getByTestId('freeze-cta-freeze'));
      fireEvent.change(screen.getByTestId('freeze-modal-reason-freeze'), {
        target: { value: LONG_REASON },
      });
      fireEvent.click(screen.getByTestId('freeze-modal-confirm-freeze'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('freeze-modal-confirm-freeze'));
        await Promise.resolve();
        await Promise.resolve();
      });
      // Now unfreeze.
      fireEvent.click(screen.getByTestId('freeze-cta-unfreeze'));
      fireEvent.change(screen.getByTestId('freeze-modal-reason-unfreeze'), {
        target: { value: 'Resuming after billing dispute resolved 2026-07-01' },
      });
      fireEvent.click(screen.getByTestId('freeze-modal-confirm-unfreeze'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('freeze-modal-confirm-unfreeze'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/v1/admin/tenants/tenant-1/products/prod-1/freeze',
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('freeze-status-pill-active'),
        ).toBeInTheDocument();
      });
    });
  });

  it('passes axe scan in the default active state', async () => {
    mockPortfolio();
    const { container } = renderCtrl();
    await waitFor(() => {
      expect(screen.getByTestId('freeze-page')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
