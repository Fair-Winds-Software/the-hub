// Authorized by HUB-1676 (E-FE-7 S3) — SystemHealthDetail shell tests.
// Covers product context load + name join + status badge mirror; 4-tab
// nav with correct aria-selected; deep-link into each tab; default
// redirect from bare detail URL to /liveness; not-found + denied paths;
// axe zero violations.
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
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import SystemHealthDetail, {
  SYSTEM_HEALTH_DETAIL_TABS,
} from '../SystemHealthDetail';
import { SystemHealthTabPlaceholder } from '../systemHealth/SystemHealthTabPlaceholder';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const HEALTH = {
  products: [
    {
      productId: PRODUCT_A,
      reachable: true,
      lastProbedAt: '2026-06-30T00:00:00.000Z',
      errorRate24h: 0.2,
      lastErrorEvent: null,
    },
  ],
  generatedAt: '2026-06-30T00:00:00.000Z',
  meta: { threshold: 0.05 },
};

const PORTFOLIO = {
  data: [{ productId: PRODUCT_A, productName: 'Synapz' }],
};

function mockDefault(health: unknown = HEALTH) {
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

function renderAt(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/console/system-health/:productId"
          element={<SystemHealthDetail />}
        >
          <Route index element={<Navigate to="liveness" replace />} />
          <Route
            path="liveness"
            element={
              <SystemHealthTabPlaceholder
                tabLabel="Liveness"
                tabId="liveness"
                storyKey="HUB-1677"
              />
            }
          />
          <Route
            path="errors"
            element={
              <SystemHealthTabPlaceholder
                tabLabel="Errors"
                tabId="errors"
                storyKey="HUB-1677"
              />
            }
          />
          <Route
            path="queues"
            element={
              <SystemHealthTabPlaceholder
                tabLabel="Queues"
                tabId="queues"
                storyKey="HUB-1678"
              />
            }
          />
          <Route
            path="webhooks"
            element={
              <SystemHealthTabPlaceholder
                tabLabel="Webhooks"
                tabId="webhooks"
                storyKey="HUB-1678"
              />
            }
          />
        </Route>
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

describe('SystemHealthDetail (HUB-1676)', () => {
  it('renders the product name + mirrored health badge', async () => {
    mockDefault();
    await act(async () => {
      renderAt(`/console/system-health/${PRODUCT_A}/liveness`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('system-health-detail-page'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('system-health-detail-heading').textContent,
    ).toBe('Synapz');
    // errorRate 0.2 >= threshold 0.05 → degraded.
    expect(screen.getByTestId('detail-status-degraded')).toBeInTheDocument();
  });

  it('renders all four tabs and marks the active one aria-selected', async () => {
    mockDefault();
    await act(async () => {
      renderAt(`/console/system-health/${PRODUCT_A}/queues`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('system-health-detail-page'),
      ).toBeInTheDocument();
    });
    for (const tab of SYSTEM_HEALTH_DETAIL_TABS) {
      expect(
        screen.getByTestId(`system-health-detail-tab-${tab.id}`),
      ).toBeInTheDocument();
    }
    expect(
      screen
        .getByTestId('system-health-detail-tab-queues')
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen
        .getByTestId('system-health-detail-tab-liveness')
        .getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('bare detail URL redirects to /liveness by default', async () => {
    mockDefault();
    await act(async () => {
      renderAt(`/console/system-health/${PRODUCT_A}`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('system-health-tab-placeholder-liveness'),
      ).toBeInTheDocument();
    });
  });

  it.each(SYSTEM_HEALTH_DETAIL_TABS.map((t) => [t.id]))(
    'deep-link to %s renders the matching placeholder',
    async (tabId) => {
      mockDefault();
      await act(async () => {
        renderAt(`/console/system-health/${PRODUCT_A}/${tabId}`);
      });
      await waitFor(() => {
        expect(
          screen.getByTestId(`system-health-tab-placeholder-${tabId}`),
        ).toBeInTheDocument();
      });
    },
  );

  it('clicking a tab navigates + updates aria-selected', async () => {
    mockDefault();
    await act(async () => {
      renderAt(`/console/system-health/${PRODUCT_A}/liveness`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('system-health-tab-placeholder-liveness'),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('system-health-detail-tab-errors'));
    await waitFor(() => {
      expect(
        screen.getByTestId('system-health-tab-placeholder-errors'),
      ).toBeInTheDocument();
    });
    expect(
      screen
        .getByTestId('system-health-detail-tab-errors')
        .getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('surfaces AccessDeniedPage when the health endpoint returns 403', async () => {
    apiGetMock.mockImplementation(() =>
      Promise.reject(new PermissionDeniedError(403, 'no scope')),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt(`/console/system-health/${PRODUCT_A}/liveness`);
    });
    await waitFor(() => {
      expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
    });
    errSpy.mockRestore();
  });

  it('surfaces the not-found copy when the product is absent from both endpoints', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/system-health/portfolio')) {
        return Promise.resolve({
          products: [],
          generatedAt: '2026-06-30T00:00:00.000Z',
          meta: { threshold: 0.05 },
        });
      }
      if (path.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({ data: [] });
      }
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      renderAt(`/console/system-health/${PRODUCT_A}/liveness`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('system-health-detail-not-found'),
      ).toBeInTheDocument();
    });
  });

  it('passes axe scan in the ready state', async () => {
    mockDefault();
    const { container } = renderAt(
      `/console/system-health/${PRODUCT_A}/liveness`,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('system-health-detail-page'),
      ).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
