// Authorized by HUB-1656 (E-FE-5 S6) — AddOnsManager tests. Thin mirror of
// HUB-1655's PlansManager coverage: list load, includeArchived toggle,
// New / Edit / Archive flows, 422 active-subscribers guard, axe.
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
import AddOnsManager from '../AddOnsManager';

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

const ADDON_ACTIVE = {
  id: 'addon-active-1',
  product_id: 'prod-1',
  key: 'sms',
  name: 'SMS Notifications',
  description: null,
  billing_type: 'recurring',
  billing_interval: 'month',
  unit_amount_cents: 1900,
  active: true,
  archived_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const ADDON_ARCHIVED = {
  ...ADDON_ACTIVE,
  id: 'addon-archived-1',
  key: 'legacy-addon',
  name: 'Legacy Addon',
  archived_at: '2026-02-01T00:00:00.000Z',
  active: false,
};

function mockDefault(addons: unknown[] = [ADDON_ACTIVE]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.startsWith('/api/v1/admin/addons')) {
      return Promise.resolve({ data: addons, total: addons.length });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderAddons() {
  return render(
    <MemoryRouter initialEntries={['/console/products/prod-1/pricing/addons']}>
      <Routes>
        <Route
          path="/console/products/:productId/pricing/addons"
          element={<AddOnsManager />}
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

describe('AddOnsManager (HUB-1656)', () => {
  it('lists active add-ons from the S2 endpoint', async () => {
    mockDefault();
    await act(async () => {
      renderAddons();
    });
    await waitFor(() => {
      expect(screen.getByTestId('addons-manager-page')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('addons-manager-row-addon-active-1'),
    ).toBeInTheDocument();
  });

  it('empty state renders CTA copy when zero add-ons exist', async () => {
    mockDefault([]);
    await act(async () => {
      renderAddons();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('addons-manager-empty'),
      ).toBeInTheDocument();
    });
  });

  it('Show archived toggle threads includeArchived=true through and surfaces archived rows', async () => {
    mockDefault();
    await act(async () => {
      renderAddons();
    });
    await waitFor(() => {
      expect(screen.getByTestId('addons-manager-page')).toBeInTheDocument();
    });
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({ data: [PRODUCT] });
      }
      if (path.includes('includeArchived=true')) {
        return Promise.resolve({
          data: [ADDON_ACTIVE, ADDON_ARCHIVED],
          total: 2,
        });
      }
      return Promise.resolve({ data: [ADDON_ACTIVE], total: 1 });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('addons-manager-show-archived'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('addons-manager-row-addon-archived-1'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('addons-manager-archived-badge-addon-archived-1'),
    ).toBeInTheDocument();
  });

  it('New Add-on modal auto-generates the key from the name, then POSTs on Create', async () => {
    mockDefault();
    apiPostMock.mockResolvedValueOnce({
      ...ADDON_ACTIVE,
      id: 'newly-created',
      name: 'Priority Support',
      key: 'priority-support',
    });
    await act(async () => {
      renderAddons();
    });
    await waitFor(() => {
      expect(screen.getByTestId('addons-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('addons-manager-new'));
    const name = screen.getByTestId('new-addon-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Priority Support' } });
    fireEvent.blur(name);
    expect(
      (screen.getByTestId('new-addon-key') as HTMLInputElement).value,
    ).toBe('priority-support');
    fireEvent.change(screen.getByTestId('new-addon-unit-amount'), {
      target: { value: '9900' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-addon-submit'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/v1/admin/addons',
      expect.objectContaining({
        productId: 'prod-1',
        key: 'priority-support',
        name: 'Priority Support',
        unit_amount_cents: 9900,
        billing_type: 'recurring',
      }),
    );
  });

  it('Edit modal PUTs the patched fields to the S2 endpoint', async () => {
    mockDefault();
    apiPutMock.mockResolvedValueOnce(ADDON_ACTIVE);
    await act(async () => {
      renderAddons();
    });
    await waitFor(() => {
      expect(screen.getByTestId('addons-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByTestId('addons-manager-edit-addon-active-1'),
    );
    fireEvent.change(screen.getByTestId('edit-addon-name'), {
      target: { value: 'SMS Renamed' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-addon-submit'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiPutMock).toHaveBeenCalledWith(
      '/api/v1/admin/addons/addon-active-1',
      expect.objectContaining({ name: 'SMS Renamed' }),
    );
  });

  it('Archive dialog DELETEs on confirm', async () => {
    mockDefault();
    apiDeleteMock.mockResolvedValueOnce({});
    await act(async () => {
      renderAddons();
    });
    await waitFor(() => {
      expect(screen.getByTestId('addons-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByTestId('addons-manager-archive-addon-active-1'),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('archive-addon-confirm'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiDeleteMock).toHaveBeenCalledWith(
      '/api/v1/admin/addons/addon-active-1',
    );
  });

  it('Archive 422 with activeSubscribers surfaces the blocked copy + hides confirm', async () => {
    mockDefault();
    apiDeleteMock.mockRejectedValueOnce(
      new Error('Add-on has 2 active subscriber(s) {"activeSubscribers":2}'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAddons();
    });
    await waitFor(() => {
      expect(screen.getByTestId('addons-manager-page')).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByTestId('addons-manager-archive-addon-active-1'),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('archive-addon-confirm'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByTestId('archive-addon-blocked-copy').textContent,
    ).toMatch(/2/);
    expect(
      screen.queryByTestId('archive-addon-confirm'),
    ).toBeNull();
    errSpy.mockRestore();
  });

  it('passes axe scan in the ready state', async () => {
    mockDefault();
    const { container } = renderAddons();
    await waitFor(() => {
      expect(screen.getByTestId('addons-manager-page')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
