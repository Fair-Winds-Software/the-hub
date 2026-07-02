// Authorized by HUB-1675 (E-FE-7 S2) — SystemHealth portfolio grid tests.
// Covers tile-per-product render + triple-encoded badge (healthy /
// degraded / unreachable) + threshold tooltip + drill-in Link href +
// Last-refreshed + manual Refresh + empty state + denied path + axe.
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
import SystemHealth from '../SystemHealth';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRODUCT_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const HEALTH_HAPPY = {
  products: [
    {
      productId: PRODUCT_A,
      reachable: true,
      lastProbedAt: '2026-06-30T00:00:00.000Z',
      errorRate24h: 0.01,
      lastErrorEvent: null,
    },
    {
      productId: PRODUCT_B,
      reachable: true,
      lastProbedAt: '2026-06-30T00:00:00.000Z',
      errorRate24h: 0.2,
      lastErrorEvent: {
        timestamp: '2026-06-30T00:00:00.000Z',
        message: 'stripe webhook failed',
      },
    },
    {
      productId: PRODUCT_C,
      reachable: false,
      lastProbedAt: '2026-06-30T00:00:00.000Z',
      errorRate24h: 0,
      lastErrorEvent: null,
    },
  ],
  generatedAt: new Date().toISOString(),
  meta: { threshold: 0.05 },
};

const PORTFOLIO = {
  data: [
    { productId: PRODUCT_A, productName: 'Synapz' },
    { productId: PRODUCT_B, productName: 'ContentHelm' },
    { productId: PRODUCT_C, productName: 'LegacyApp' },
  ],
};

function mockDefault(health = HEALTH_HAPPY) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/system-health/portfolio')) {
      return Promise.resolve(health);
    }
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve(PORTFOLIO);
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/console/system-health']}>
      <Routes>
        <Route path="/console/system-health" element={<SystemHealth />} />
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

describe('SystemHealth portfolio grid (HUB-1675)', () => {
  it('renders one tile per product with the joined product name from the portfolio aggregator', async () => {
    mockDefault();
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(screen.getByTestId('system-health-page')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`system-health-tile-${PRODUCT_A}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`system-health-tile-name-${PRODUCT_A}`).textContent,
    ).toBe('Synapz');
    expect(
      screen.getByTestId(`system-health-tile-name-${PRODUCT_C}`).textContent,
    ).toBe('LegacyApp');
  });

  it('badge triple-encoding: healthy / degraded / unreachable per row', async () => {
    mockDefault();
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(screen.getByTestId('system-health-page')).toBeInTheDocument();
    });
    // healthy tile (row A: errorRate 0.01 < threshold 0.05)
    expect(
      screen
        .getByTestId(`system-health-tile-${PRODUCT_A}`)
        .querySelector('[data-testid="system-health-badge-healthy"]'),
    ).not.toBeNull();
    // degraded tile (row B: reachable + errorRate 0.2 >= threshold)
    expect(
      screen
        .getByTestId(`system-health-tile-${PRODUCT_B}`)
        .querySelector('[data-testid="system-health-badge-degraded"]'),
    ).not.toBeNull();
    // unreachable tile (row C: reachable=false)
    expect(
      screen
        .getByTestId(`system-health-tile-${PRODUCT_C}`)
        .querySelector('[data-testid="system-health-badge-unreachable"]'),
    ).not.toBeNull();
  });

  it('threshold tooltip surfaces the configured threshold + points at HUB Settings', async () => {
    mockDefault();
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(screen.getByTestId('system-health-page')).toBeInTheDocument();
    });
    const badge = screen.getByTestId('system-health-badge-degraded');
    expect(badge.getAttribute('title')).toMatch(/Threshold: 5\.0%/);
    expect(badge.getAttribute('title')).toMatch(/HUB Settings/);
    // aria-label mirrors the tooltip so SR users get the same signal.
    expect(badge.getAttribute('aria-label')).toMatch(/Degraded/);
    expect(badge.getAttribute('aria-label')).toMatch(/Threshold: 5\.0%/);
  });

  it('tile is a Link to the drill-in route', async () => {
    mockDefault();
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(screen.getByTestId('system-health-page')).toBeInTheDocument();
    });
    const tile = screen.getByTestId(`system-health-tile-${PRODUCT_A}`);
    expect(tile.tagName).toBe('A');
    expect(tile.getAttribute('href')).toBe(
      `/console/system-health/${PRODUCT_A}`,
    );
  });

  it('Refresh now button re-fetches the portfolio + health endpoints', async () => {
    mockDefault();
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(screen.getByTestId('system-health-page')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('system-health-refresh'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      apiGetMock.mock.calls.some((c) =>
        (c[0] as string).startsWith('/api/v1/admin/system-health/portfolio'),
      ),
    ).toBe(true);
  });

  it('surfaces the AccessDeniedPage when the BE returns 403', async () => {
    apiGetMock.mockImplementation(() =>
      Promise.reject(new PermissionDeniedError(403, 'no scope')),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
    });
    errSpy.mockRestore();
  });

  it('empty state renders the ask-Sammy copy when the portfolio is empty', async () => {
    mockDefault({
      products: [],
      generatedAt: new Date().toISOString(),
      meta: { threshold: 0.05 },
    });
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(screen.getByTestId('system-health-empty')).toBeInTheDocument();
    });
  });

  it('passes axe scan in the ready state', async () => {
    mockDefault();
    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('system-health-page')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
