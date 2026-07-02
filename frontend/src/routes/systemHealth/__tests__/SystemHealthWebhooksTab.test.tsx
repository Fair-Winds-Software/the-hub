// Authorized by HUB-1678 (E-FE-7 S5) — Webhooks tab tests. Covers 4-tile
// MetricTile render + Intl percent + verdict color mapping + window
// selector + Refresh flow + last-failure line + axe.
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
import SystemHealthWebhooksTab from '../SystemHealthWebhooksTab';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

function mockWebhooks(overrides: Record<string, unknown> = {}) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/system-health/stripe-webhooks')) {
      return Promise.resolve({
        successCount: 950,
        failureCount: 5,
        successRate: 0.995,
        lastFailedAt: '2026-06-30T00:00:00.000Z',
        pendingRetryCount: 2,
        generatedAt: '2026-06-30T00:00:00.000Z',
        ...overrides,
      });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderTab() {
  return render(
    <MemoryRouter>
      <SystemHealthWebhooksTab />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SystemHealthWebhooksTab (HUB-1678)', () => {
  it('renders 4 MetricTile boxes seeded from the response', async () => {
    mockWebhooks();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('webhooks-tab')).toBeInTheDocument();
    });
    const tiles = screen.getAllByTestId('metric-tile');
    expect(tiles).toHaveLength(4);
    // Success rate rendered as percent via Intl.
    const values = screen.getAllByTestId('metric-tile-value');
    expect(values[0]!.textContent).toMatch(/99\.5%/);
    expect(values[1]!.textContent).toBe('950');
    expect(values[2]!.textContent).toBe('5');
    expect(values[3]!.textContent).toBe('2');
  });

  it('Failed tile renders error verdict when failureCount > 0', async () => {
    mockWebhooks();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('webhooks-tab')).toBeInTheDocument();
    });
    // Multiple verdict elements — one per tile — at least one 'error' for Failed.
    const errorVerdicts = screen.getAllByTestId('metric-tile-verdict-error');
    expect(errorVerdicts.length).toBeGreaterThan(0);
  });

  it('window selector fires a new GET with the updated windowHours', async () => {
    mockWebhooks();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('webhooks-tab')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/system-health/stripe-webhooks')) {
        return Promise.resolve({
          successCount: 0,
          failureCount: 0,
          successRate: 1,
          lastFailedAt: null,
          pendingRetryCount: 0,
          generatedAt: '2026-06-30T00:00:00.000Z',
        });
      }
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('webhooks-window-7d'));
      await Promise.resolve();
    });
    const call = apiGetMock.mock.calls[0]![0] as string;
    expect(call).toContain('windowHours=168');
  });

  it('last-failure line switches to no-failures copy when lastFailedAt is null', async () => {
    mockWebhooks({
      failureCount: 0,
      lastFailedAt: null,
      pendingRetryCount: 0,
      successRate: 1,
    });
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('webhooks-tab')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('webhooks-last-failure').textContent,
    ).toMatch(/No failures/);
  });

  it('Refresh now hits the ?fresh=true URL and surfaces the transient badge', async () => {
    mockWebhooks();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('webhooks-tab')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/system-health/stripe-webhooks')) {
        return Promise.resolve({
          successCount: 0,
          failureCount: 0,
          successRate: 1,
          lastFailedAt: null,
          pendingRetryCount: 0,
          generatedAt: '2026-06-30T00:00:00.000Z',
        });
      }
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('webhooks-refresh'));
      await Promise.resolve();
      await Promise.resolve();
    });
    const call = apiGetMock.mock.calls[0]![0] as string;
    expect(call).toContain('fresh=true');
    expect(
      screen.getByTestId('webhooks-refreshed-badge'),
    ).toBeInTheDocument();
  });

  it('passes axe scan in the ready state', async () => {
    mockWebhooks();
    const { container } = renderTab();
    await waitFor(() => {
      expect(screen.getByTestId('webhooks-tab')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
