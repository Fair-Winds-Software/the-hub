// Authorized by HUB-1665 (E-FE-6 S6) — NotificationsManager tests. Covers
// product picker + channel list load, per-type badges, includeArchived
// toggle, New Channel modal (JSON config validation + POST payload
// shape), Edit modal (channel_type locked + PUT), Archive two-step
// confirm + DELETE, and axe zero violations.
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
import { MemoryRouter } from 'react-router-dom';
import NotificationsManager from '../NotificationsManager';

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

const CHANNEL_EMAIL = {
  id: 'ch-email-1',
  tenant_id: 'tenant-1',
  product_id: 'prod-1',
  channel_type: 'email',
  config: { to_addresses: ['ops@maverick.launch'] },
  enabled: true,
  archived_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
};

const CHANNEL_WEBHOOK = {
  ...CHANNEL_EMAIL,
  id: 'ch-webhook-1',
  channel_type: 'webhook',
  config: { url: 'https://example.com/webhook' },
};

const CHANNEL_ARCHIVED = {
  ...CHANNEL_EMAIL,
  id: 'ch-archived-1',
  archived_at: '2026-06-15T00:00:00.000Z',
  enabled: false,
};

function mockPortfolioAndChannels(channels: unknown[] = [CHANNEL_EMAIL]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [PRODUCT] });
    }
    if (path.startsWith('/api/v1/admin/notifications/')) {
      return Promise.resolve({ channels });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderMgr() {
  return render(
    <MemoryRouter>
      <NotificationsManager />
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

describe('NotificationsManager (HUB-1665)', () => {
  it('loads the product picker but shows no channels until a product is picked', async () => {
    mockPortfolioAndChannels();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('notifications-product-picker'),
    ).toBeInTheDocument();
    // Nothing fetched from /channels yet — no list rendered.
    expect(screen.queryByTestId('notifications-list')).toBeNull();
    expect(screen.queryByTestId('notifications-empty')).toBeNull();
  });

  it('selecting a product fetches channels and renders one row per channel', async () => {
    mockPortfolioAndChannels([CHANNEL_EMAIL, CHANNEL_WEBHOOK]);
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('notifications-product-picker'), {
        target: { value: 'prod-1' },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId('notifications-list')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('notifications-row-ch-email-1'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('notifications-row-ch-webhook-1'),
    ).toBeInTheDocument();
    // Triple-encoded channel-type badges.
    expect(screen.getByTestId('channel-type-email')).toBeInTheDocument();
    expect(screen.getByTestId('channel-type-webhook')).toBeInTheDocument();
  });

  it('Show archived toggle threads includeArchived=true through the channels GET', async () => {
    mockPortfolioAndChannels();
    await act(async () => {
      renderMgr();
    });
    await waitFor(() => {
      expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('notifications-product-picker'), {
        target: { value: 'prod-1' },
      });
      await Promise.resolve();
    });
    apiGetMock.mockClear();
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({ data: [PRODUCT] });
      }
      if (path.startsWith('/api/v1/admin/notifications/')) {
        return Promise.resolve({ channels: [CHANNEL_EMAIL, CHANNEL_ARCHIVED] });
      }
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('notifications-show-archived'));
      await Promise.resolve();
    });
    await waitFor(() => {
      const channelsCall = apiGetMock.mock.calls.find((c) =>
        (c[0] as string).startsWith('/api/v1/admin/notifications/'),
      );
      expect(channelsCall![0]).toContain('includeArchived=true');
    });
  });

  describe('New Channel modal', () => {
    it('rejects invalid JSON in the config textarea', async () => {
      mockPortfolioAndChannels();
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('notifications-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('notifications-new'));
      fireEvent.change(screen.getByTestId('channel-modal-config'), {
        target: { value: '{"to_addresses":' },
      });
      fireEvent.click(screen.getByTestId('channel-modal-submit'));
      expect(
        screen.getByTestId('channel-modal-config-err').textContent,
      ).toMatch(/Invalid JSON/);
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it('valid config POSTs the parsed body to the tenant-scoped channels endpoint', async () => {
      mockPortfolioAndChannels();
      apiPostMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('notifications-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('notifications-new'));
      fireEvent.change(screen.getByTestId('channel-modal-config'), {
        target: { value: '{"to_addresses":["ops@maverick.launch"]}' },
      });
      fireEvent.change(screen.getByTestId('channel-modal-hmac'), {
        target: { value: 'sekret' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('channel-modal-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/v1/admin/notifications/tenant-1/prod-1/channels',
        expect.objectContaining({
          channel_type: 'email',
          config: { to_addresses: ['ops@maverick.launch'] },
          hmac_secret: 'sekret',
          enabled: true,
        }),
      );
    });
  });

  describe('Edit Channel modal', () => {
    it('locks channel_type dropdown + PUTs the updated body', async () => {
      mockPortfolioAndChannels([CHANNEL_EMAIL]);
      apiPutMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('notifications-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('notifications-edit-ch-email-1'));
      expect(
        (screen.getByTestId('channel-modal-type') as HTMLSelectElement).disabled,
      ).toBe(true);
      fireEvent.click(screen.getByTestId('channel-modal-enabled'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('channel-modal-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiPutMock).toHaveBeenCalledWith(
        '/api/v1/admin/notifications/tenant-1/prod-1/channels/ch-email-1',
        expect.objectContaining({ enabled: false }),
      );
    });
  });

  describe('Archive two-step confirm', () => {
    it('first Continue reveals the confirm panel; second click DELETEs', async () => {
      mockPortfolioAndChannels([CHANNEL_EMAIL]);
      apiDeleteMock.mockResolvedValueOnce({});
      await act(async () => {
        renderMgr();
      });
      await waitFor(() => {
        expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('notifications-product-picker'), {
          target: { value: 'prod-1' },
        });
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId('notifications-archive-ch-email-1'));
      fireEvent.click(screen.getByTestId('archive-channel-confirm'));
      expect(
        screen.getByTestId('archive-channel-confirm-panel'),
      ).toBeInTheDocument();
      expect(apiDeleteMock).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(screen.getByTestId('archive-channel-confirm'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiDeleteMock).toHaveBeenCalledWith(
        '/api/v1/admin/notifications/tenant-1/prod-1/channels/ch-email-1',
      );
    });
  });

  it('passes axe scan in the picker + list state', async () => {
    mockPortfolioAndChannels([CHANNEL_EMAIL]);
    const { container } = renderMgr();
    await waitFor(() => {
      expect(screen.getByTestId('notifications-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('notifications-product-picker'), {
        target: { value: 'prod-1' },
      });
      await Promise.resolve();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
