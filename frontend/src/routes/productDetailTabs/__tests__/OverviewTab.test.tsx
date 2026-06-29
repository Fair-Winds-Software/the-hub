// Authorized by HUB-1605 (E-FE-3 S5) — OverviewTab tests. Covers field display
// (Status / Version / Health / Email / Deploy Date / Last Active / MRR / Tenant),
// lazy health probe (loading → ok / unavailable / 404 fallback), inline-edit
// Status (click pencil → select → save success / error revert / Escape cancel),
// optimistic update + revert, aria-live status region, and axe-core a11y.
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
import { OverviewTab } from '../OverviewTab';
import type { PortfolioProduct } from '../../Products';

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
  },
}));

const PRODUCT: PortfolioProduct = {
  productId: 'p-1',
  productName: 'Synapz',
  tenantId: 't-1',
  tenantName: 'Maverick Launch',
  status: 'active',
  mrrCents: 1250000,
  createdAt: '2025-01-15T00:00:00.000Z',
  lastActiveAt: '2026-06-20T12:00:00.000Z',
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiPatchMock.mockReset();
  // Default health → ok.
  apiGetMock.mockImplementation((path: string) => {
    if (path.endsWith('/health')) {
      return Promise.resolve({ available: true });
    }
    return Promise.reject(new Error(`unexpected GET: ${path}`));
  });
});

afterEach(() => {
  cleanup();
});

describe('OverviewTab (HUB-1605)', () => {
  describe('field display', () => {
    it('renders Status / Version / Health / Email / Deploy Date / Last Active / MRR / Tenant rows', () => {
      render(<OverviewTab product={PRODUCT} />);
      for (const id of [
        'overview-field-status',
        'overview-field-version',
        'overview-field-health',
        'overview-field-email',
        'overview-field-deploy-date',
        'overview-field-last-active',
        'overview-field-mrr',
        'overview-field-tenant',
      ]) {
        expect(screen.getByTestId(id)).toBeInTheDocument();
      }
    });

    it('formats MRR as USD; tenant name from product', () => {
      render(<OverviewTab product={PRODUCT} />);
      expect(screen.getByTestId('overview-field-mrr').textContent).toContain(
        '$12,500',
      );
      expect(screen.getByTestId('overview-field-tenant').textContent).toContain(
        'Maverick Launch',
      );
    });

    it('renders version and email as "—" at v0.1 (BE schema gap)', () => {
      render(<OverviewTab product={PRODUCT} />);
      expect(screen.getByTestId('overview-field-version').textContent).toContain('—');
      expect(screen.getByTestId('overview-field-email').textContent).toContain('—');
    });
  });

  describe('AC#8 — API Health lazy probe', () => {
    it('starts with "checking…" then resolves to OK when /health is available', async () => {
      render(<OverviewTab product={PRODUCT} />);
      expect(screen.getByTestId('overview-health-loading')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('overview-health-ok')).toBeInTheDocument();
      });
      // Probe call fired against the productId-scoped path.
      const healthCalls = apiGetMock.mock.calls
        .map((c) => c[0] as string)
        .filter((p) => p.endsWith('/health'));
      expect(healthCalls).toHaveLength(1);
      expect(healthCalls[0]).toContain('/api/v1/admin/products/p-1/health');
    });

    it('degrades to unavailable when /health returns available:false', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.endsWith('/health')) {
          return Promise.resolve({ available: false, reason: 'timeout' });
        }
        return Promise.reject(new Error('unexpected'));
      });
      render(<OverviewTab product={PRODUCT} />);
      await waitFor(() => {
        expect(
          screen.getByTestId('overview-health-unavailable'),
        ).toBeInTheDocument();
      });
    });

    it('degrades to unavailable when /health endpoint is missing (404 / throw)', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.endsWith('/health')) {
          return Promise.reject(new Error('Request failed: 404'));
        }
        return Promise.reject(new Error('unexpected'));
      });
      render(<OverviewTab product={PRODUCT} />);
      await waitFor(() => {
        expect(
          screen.getByTestId('overview-health-unavailable'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('AC#3 — inline-edit Status: success path', () => {
    it('click pencil → swap to select → change value → optimistic update + PATCH fires', async () => {
      apiPatchMock.mockResolvedValue({});
      const onChange = vi.fn();
      render(<OverviewTab product={PRODUCT} onProductChange={onChange} />);
      // Pre-edit: value visible, no select.
      expect(screen.getByTestId('overview-status-value').textContent).toBe(
        'active',
      );
      expect(screen.queryByTestId('overview-status-select')).toBeNull();

      // Click the pencil to enter edit mode.
      act(() => {
        fireEvent.click(screen.getByTestId('overview-status-edit-button'));
      });
      const select = screen.getByTestId(
        'overview-status-select',
      ) as HTMLSelectElement;
      expect(select).toBeInTheDocument();

      // Change to 'inactive' — fires save (optimistic + PATCH).
      await act(async () => {
        fireEvent.change(select, { target: { value: 'inactive' } });
        await Promise.resolve();
        await Promise.resolve();
      });

      // PATCH was called against /api/v1/admin/products/p-1 with the new status.
      expect(apiPatchMock).toHaveBeenCalledTimes(1);
      expect(apiPatchMock.mock.calls[0][0]).toBe('/api/v1/admin/products/p-1');
      expect(apiPatchMock.mock.calls[0][1]).toEqual({ status: 'inactive' });
      // Edit collapses back to display mode with the new value.
      await waitFor(() => {
        expect(screen.queryByTestId('overview-status-select')).toBeNull();
      });
      expect(screen.getByTestId('overview-status-value').textContent).toBe(
        'inactive',
      );
      // Parent notified of the change so the page header badge can mirror it.
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'inactive' }),
      );
    });
  });

  describe('AC#6/#7 — inline-edit Status: failure path reverts', () => {
    it('PATCH 400 → revert to original status + inline error per error-message-guidelines', async () => {
      apiPatchMock.mockRejectedValue(
        new Error("Invalid status transition: cannot move from 'active' to 'archived' directly"),
      );
      render(<OverviewTab product={PRODUCT} />);
      act(() => {
        fireEvent.click(screen.getByTestId('overview-status-edit-button'));
      });
      const select = screen.getByTestId(
        'overview-status-select',
      ) as HTMLSelectElement;
      await act(async () => {
        fireEvent.change(select, { target: { value: 'archived' } });
        await Promise.resolve();
        await Promise.resolve();
      });
      // After save fails the optimistic update is reverted; we stay in edit mode
      // so the operator can retry or pick a different value. Select value reverts
      // to the original and the inline error is announced.
      await waitFor(() => {
        const stillEditingSelect = screen.getByTestId(
          'overview-status-select',
        ) as HTMLSelectElement;
        expect(stillEditingSelect.value).toBe('active');
      });
      expect(screen.getByTestId('overview-status-error').textContent).toMatch(
        /Invalid status transition/,
      );
    });
  });

  describe('AC#3 — inline-edit Status: Escape cancels', () => {
    it('pressing Escape on the select reverts to display mode without firing PATCH', () => {
      render(<OverviewTab product={PRODUCT} />);
      act(() => {
        fireEvent.click(screen.getByTestId('overview-status-edit-button'));
      });
      const select = screen.getByTestId(
        'overview-status-select',
      ) as HTMLSelectElement;
      act(() => {
        fireEvent.keyDown(select, { key: 'Escape' });
      });
      expect(screen.queryByTestId('overview-status-select')).toBeNull();
      expect(apiPatchMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('overview-status-value').textContent).toBe(
        'active',
      );
    });
  });

  describe('AC#9 — tab unmount cleanup', () => {
    it('unmounting before PATCH resolves does not leak a state update or onProductChange call', async () => {
      let resolvePatch: (v: unknown) => void = () => {};
      apiPatchMock.mockImplementation(
        () => new Promise((res) => {
          resolvePatch = res;
        }),
      );
      const onChange = vi.fn();
      const { unmount } = render(
        <OverviewTab product={PRODUCT} onProductChange={onChange} />,
      );
      act(() => {
        fireEvent.click(screen.getByTestId('overview-status-edit-button'));
      });
      const select = screen.getByTestId(
        'overview-status-select',
      ) as HTMLSelectElement;
      act(() => {
        fireEvent.change(select, { target: { value: 'inactive' } });
      });
      // Unmount before the PATCH resolves.
      unmount();
      // Then let the PATCH resolve — the cancelled ref short-circuits the post-resolve work.
      await act(async () => {
        resolvePatch({});
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with default state', async () => {
      const { container } = render(<OverviewTab product={PRODUCT} />);
      await waitFor(() => {
        expect(screen.getByTestId('overview-health-ok')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan during inline-edit (select mounted)', async () => {
      const { container } = render(<OverviewTab product={PRODUCT} />);
      act(() => {
        fireEvent.click(screen.getByTestId('overview-status-edit-button'));
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
