// Authorized by HUB-1683 (E-FE-9 S4) — drill-in shell tests: header
// render, back link, two-column layout, chart with 90d timeline, chart
// empty state, 403 → denied panel, 404 → not-found template, no
// productId → error surface.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CustomerHealthDetail from '../CustomerHealthDetail';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeTimeline(n: number): Array<{ date: string; eventCount: number; activeDays: number }> {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getTime() - (n - 1 - i) * 24 * 60 * 60 * 1000);
    return {
      date: d.toISOString().slice(0, 10),
      eventCount: Math.max(0, Math.round(10 + Math.sin(i / 3) * 5)),
      activeDays: Math.min(7, i + 1),
    };
  });
}

const HAPPY_DETAIL = {
  tenant: { id: TENANT_A, name: 'Acme' },
  product: { id: PRODUCT_A, name: 'Synapz' },
  currentPlan: { key: 'growth' },
  mrr: { cents: 250000, currency: 'USD' },
  healthBadge: 'red',
  churnRiskScore: 0.85,
  lastActiveAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  lastAdvisorRunAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
  signals: [
    {
      key: 'stale_no_activity',
      label: 'No activity for 14+ days',
      severity: 'high',
      contributesPoints: 0.3,
      active: true,
    },
  ],
  usageTimeline90d: makeTimeline(30),
  meta: { thresholds: { red: 0.7, yellow: 0.4, staleDays: 14 } },
};

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/console/customer-health/:tenantId"
          element={<CustomerHealthDetail />}
        />
        <Route
          path="/console/customer-health"
          element={<div data-testid="stub-list" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue(HAPPY_DETAIL);
});

afterEach(() => {
  cleanup();
});

describe('CustomerHealthDetail (HUB-1683)', () => {
  it('renders the header + chart + signals-panel container', async () => {
    await act(async () => {
      renderAt(`/console/customer-health/${TENANT_A}?productId=${PRODUCT_A}`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('customer-health-detail-page'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('customer-health-detail-heading').textContent,
    ).toBe('Acme');
    expect(
      screen.getByTestId('customer-health-detail-badge-red'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('customer-health-detail-left'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('customer-health-detail-right'),
    ).toBeInTheDocument();
    // Chart present (data ≥ 1 point).
    expect(screen.getByTestId('usage-timeline-chart')).toBeInTheDocument();
  });

  it('back link points at the list', async () => {
    await act(async () => {
      renderAt(`/console/customer-health/${TENANT_A}?productId=${PRODUCT_A}`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('customer-health-detail-back'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('customer-health-detail-back').getAttribute('href'),
    ).toBe('/console/customer-health');
  });

  it('empty usage timeline renders the "stale-no-activity" empty message', async () => {
    apiGetMock.mockResolvedValue({ ...HAPPY_DETAIL, usageTimeline90d: [] });
    await act(async () => {
      renderAt(`/console/customer-health/${TENANT_A}?productId=${PRODUCT_A}`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('usage-timeline-empty'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('usage-timeline-empty').textContent,
    ).toContain('No usage activity in the last 90 days');
  });

  it('missing productId → error surface with retry', async () => {
    await act(async () => {
      renderAt(`/console/customer-health/${TENANT_A}`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('customer-health-detail-error'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('customer-health-detail-error').textContent,
    ).toContain('productId query is required');
  });

  it('403 → AccessDeniedPage', async () => {
    apiGetMock.mockRejectedValueOnce(new PermissionDeniedError(403, 'no'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt(`/console/customer-health/${TENANT_A}?productId=${PRODUCT_A}`);
    });
    await waitFor(() => {
      expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
    });
    errSpy.mockRestore();
  });

  it('404 → not-found template with back link', async () => {
    apiGetMock.mockRejectedValueOnce(
      new Error('Tenant + product pair not found'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt(`/console/customer-health/${TENANT_A}?productId=${PRODUCT_A}`);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('customer-health-detail-not-found'),
      ).toBeInTheDocument();
    });
    errSpy.mockRestore();
  });
});
