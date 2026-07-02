// Authorized by HUB-1677 (E-FE-7 S4) — Liveness tab tests. Covers
// reachable badge triple-encoding, lastError block vs no-errors state,
// Re-probe now button that hits the ?fresh=true endpoint + shows the
// transient 'Re-probed just now' badge, and axe.
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
import SystemHealthLivenessTab from '../SystemHealthLivenessTab';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function health(overrides: Record<string, unknown> = {}) {
  return {
    products: [
      {
        productId: PRODUCT,
        reachable: true,
        lastProbedAt: '2026-06-30T00:00:00.000Z',
        errorRate24h: 0.02,
        lastErrorEvent: null,
        ...overrides,
      },
    ],
    generatedAt: '2026-06-30T00:00:00.000Z',
    meta: { threshold: 0.05 },
  };
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={[`/console/system-health/${PRODUCT}/liveness`]}>
      <Routes>
        <Route
          path="/console/system-health/:productId/liveness"
          element={<SystemHealthLivenessTab />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SystemHealthLivenessTab (HUB-1677)', () => {
  it('renders the reachable badge + no-errors state when the row is clean', async () => {
    apiGetMock.mockResolvedValue(health());
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('liveness-tab')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('liveness-badge-reachable'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('liveness-no-errors')).toBeInTheDocument();
  });

  it('renders the unreachable badge + the last-error block when the row carries an event', async () => {
    apiGetMock.mockResolvedValue(
      health({
        reachable: false,
        lastErrorEvent: {
          timestamp: '2026-06-30T00:00:00.000Z',
          message: 'stripe webhook 502',
        },
      }),
    );
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('liveness-badge-unreachable'),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('liveness-last-error').textContent).toMatch(
      /stripe webhook 502/,
    );
  });

  it('Re-probe now button hits the ?fresh=true URL and surfaces the transient badge', async () => {
    apiGetMock.mockResolvedValue(health());
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('liveness-tab')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('liveness-reprobe'));
      await Promise.resolve();
      await Promise.resolve();
    });
    const call = apiGetMock.mock.calls[0]![0] as string;
    expect(call).toContain('fresh=true');
    expect(
      screen.getByTestId('liveness-reprobed-badge'),
    ).toBeInTheDocument();
  });

  it('passes axe scan in the ready state', async () => {
    apiGetMock.mockResolvedValue(health());
    const { container } = renderTab();
    await waitFor(() => {
      expect(screen.getByTestId('liveness-tab')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
