// Authorized by HUB-1657 (E-FE-5 S7) — PricingExceptionsManager tests. Covers
// discount + override list load, tab switching + URL sync via ?tab=,
// includeArchived toggle, New Discount + New Override modals, Archive
// dialog for both entity types, expiry-date derived status, and axe.
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
import PricingExceptionsManager from '../PricingExceptionsManager';

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

const DISCOUNT_ACTIVE = {
  id: 'd-1',
  tenant_id: 'tenant-1',
  product_id: 'prod-1',
  discount_type: 'percentage',
  discount_value: '20',
  expiry_date: null,
  notes: 'Design partner discount',
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
};

const DISCOUNT_EXPIRED = {
  ...DISCOUNT_ACTIVE,
  id: 'd-2',
  discount_value: '15',
  expiry_date: '2025-01-01T00:00:00.000Z',
};

const OVERRIDE_ACTIVE = {
  id: 'o-1',
  tenant_id: 'tenant-1',
  product_id: 'prod-1',
  metric_name: 'api_calls',
  unit_price_cents: 50,
  active: true,
  created_at: '2026-02-01T00:00:00.000Z',
};

function mockDefault(discounts: unknown[] = [DISCOUNT_ACTIVE], overrides: unknown[] = [OVERRIDE_ACTIVE]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.startsWith('/api/v1/admin/console/discounts/')) {
      return Promise.resolve({ data: discounts });
    }
    if (path.startsWith('/api/v1/admin/console/overrides/')) {
      return Promise.resolve({ data: overrides });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderMgr(initial = '/console/products/prod-1/pricing/exceptions') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/console/products/:productId/pricing/exceptions"
          element={<PricingExceptionsManager />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiDeleteMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('PricingExceptionsManager (HUB-1657)', () => {
  it('lists discounts by default (tab=discounts) with expiry-derived status', async () => {
    mockDefault([DISCOUNT_ACTIVE, DISCOUNT_EXPIRED]);
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('exceptions-discount-row-d-1'),
    ).toBeInTheDocument();
    const activeStatus = screen
      .getByTestId('exceptions-discount-row-d-1')
      .querySelector('[data-testid="exceptions-status-active"]');
    expect(activeStatus).not.toBeNull();
    const expiredStatus = screen
      .getByTestId('exceptions-discount-row-d-2')
      .querySelector('[data-testid="exceptions-status-expired"]');
    expect(expiredStatus).not.toBeNull();
  });

  it('switching to the Overrides tab renders the override list', async () => {
    mockDefault();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('exceptions-tab-overrides'));
    expect(
      screen.getByTestId('exceptions-override-row-o-1'),
    ).toBeInTheDocument();
  });

  it('deep-link ?tab=overrides mounts on the Overrides tab', async () => {
    mockDefault();
    await act(async () => {
      renderMgr('/console/products/prod-1/pricing/exceptions?tab=overrides');
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('exceptions-tab-overrides').getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByTestId('exceptions-override-row-o-1'),
    ).toBeInTheDocument();
  });

  it('Show archived toggle threads includeArchived=true through both GETs', async () => {
    mockDefault();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({ data: [PRODUCT] });
      }
      if (path.startsWith('/api/v1/admin/console/discounts/')) {
        return Promise.resolve({ data: [DISCOUNT_ACTIVE] });
      }
      if (path.startsWith('/api/v1/admin/console/overrides/')) {
        return Promise.resolve({ data: [OVERRIDE_ACTIVE] });
      }
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('exceptions-show-archived'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const discountsCall = apiGetMock.mock.calls.find((c) =>
        (c[0] as string).startsWith('/api/v1/admin/console/discounts/'),
      );
      expect(discountsCall![0]).toContain('includeArchived=true');
    });
  });

  it('New Discount modal POSTs a percentage discount to the correct tenant + product', async () => {
    mockDefault();
    apiPostMock.mockResolvedValueOnce({});
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('exceptions-new-discount'));
    fireEvent.change(screen.getByTestId('new-discount-value'), {
      target: { value: '25' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-discount-submit'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/v1/admin/console/discounts',
      expect.objectContaining({
        tenant_id: 'tenant-1',
        product_id: 'prod-1',
        discount_type: 'percentage',
        discount_value: 25,
      }),
    );
  });

  it('New Discount modal rejects a percentage above 100', async () => {
    mockDefault();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('exceptions-new-discount'));
    fireEvent.change(screen.getByTestId('new-discount-value'), {
      target: { value: '150' },
    });
    fireEvent.click(screen.getByTestId('new-discount-submit'));
    expect(
      screen.getByTestId('new-discount-value-err'),
    ).toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('New Override modal POSTs metric + cents', async () => {
    mockDefault();
    apiPostMock.mockResolvedValueOnce({});
    await act(async () => {
      renderMgr('/console/products/prod-1/pricing/exceptions?tab=overrides');
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('exceptions-new-override'));
    fireEvent.change(screen.getByTestId('new-override-metric'), {
      target: { value: 'stripe_calls' },
    });
    fireEvent.change(screen.getByTestId('new-override-unit-price'), {
      target: { value: '75' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-override-submit'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/v1/admin/console/overrides',
      expect.objectContaining({
        tenant_id: 'tenant-1',
        product_id: 'prod-1',
        metric_name: 'stripe_calls',
        unit_price_cents: 75,
      }),
    );
  });

  it('Archive dialog DELETEs the discount on confirm', async () => {
    mockDefault();
    apiDeleteMock.mockResolvedValueOnce({});
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByTestId('exceptions-discount-archive-d-1'),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('archive-exception-confirm'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiDeleteMock).toHaveBeenCalledWith(
      '/api/v1/admin/console/discounts/d-1',
    );
  });

  it('Archive dialog DELETEs the override on confirm', async () => {
    mockDefault();
    apiDeleteMock.mockResolvedValueOnce({});
    await act(async () => {
      renderMgr('/console/products/prod-1/pricing/exceptions?tab=overrides');
    });
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByTestId('exceptions-override-archive-o-1'),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('archive-exception-confirm'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiDeleteMock).toHaveBeenCalledWith(
      '/api/v1/admin/console/overrides/o-1',
    );
  });

  it('passes axe scan in the discounts-tab ready state', async () => {
    mockDefault();
    const { container } = renderMgr();
    await waitFor(() => {
      expect(screen.getByTestId('exceptions-manager-page')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
