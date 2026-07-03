// Authorized by HUB-1685 (E-FE-9 S6) — cross-cutting NFR verification
// for the Customer Health epic. Static-source assertion that App.tsx
// wires both /console/customer-health routes behind
// GuardedRoute(product_admin); axe-core zero violations across list +
// drill-in; threshold-mutation propagation (BE meta.thresholds change
// re-derives client-side badge display).
//
// Lighthouse CWV measurement of /console/customer-health* routes
// defers to Stage 4 per D-HUB-SCOPE-051 (same in-memory session-store
// constraint as every other post-auth route). CI continues to measure
// /console/login as the canonical cold-load proxy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CustomerHealth from '../../CustomerHealth';
import CustomerHealthDetail from '../../CustomerHealthDetail';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
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

const LIST_PAYLOAD = {
  rows: [
    {
      tenantId: TENANT_A,
      tenantName: 'Acme',
      productId: PRODUCT_A,
      productName: 'Synapz',
      planKey: 'growth',
      mrrCents: 250000,
      healthBadge: 'red',
      churnRiskScore: 0.85,
      lastActiveAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      signals: ['stale_no_activity'],
    },
  ],
  total: 1,
  generatedAt: '2026-07-03T00:00:00.000Z',
  meta: { thresholds: { red: 0.7, yellow: 0.4, staleDays: 14 } },
};

const DETAIL_PAYLOAD = {
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

function mockRoutes(overrides: { listPayload?: unknown; detailPayload?: unknown } = {}) {
  apiGetMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({
        data: [{ productId: PRODUCT_A, productName: 'Synapz' }],
      });
    }
    if (url.startsWith('/api/v1/admin/customer-health/')) {
      return Promise.resolve(overrides.detailPayload ?? DETAIL_PAYLOAD);
    }
    if (url.startsWith('/api/v1/admin/customer-health')) {
      return Promise.resolve(overrides.listPayload ?? LIST_PAYLOAD);
    }
    return Promise.reject(new Error(`unexpected: ${url}`));
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  mockRoutes();
});

afterEach(() => {
  cleanup();
});

describe('Customer Health NFR verification (HUB-1685)', () => {
  describe('AC#1 — RBAC: both routes behind GuardedRoute(product_admin) in App.tsx', () => {
    it('static source check: /console/customer-health list requires product_admin', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const appPath = resolve(here, '../../../App.tsx');
      const source = readFileSync(appPath, 'utf8');
      const listIdx = source.indexOf('path="/console/customer-health"');
      expect(listIdx).toBeGreaterThan(-1);
      const listWindow = source.slice(listIdx, listIdx + 400);
      expect(listWindow).toContain('requiredRole="product_admin"');
    });

    it('static source check: /console/customer-health/:tenantId drill-in requires product_admin', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const appPath = resolve(here, '../../../App.tsx');
      const source = readFileSync(appPath, 'utf8');
      const idx = source.indexOf('path="/console/customer-health/:tenantId"');
      expect(idx).toBeGreaterThan(-1);
      const window = source.slice(idx, idx + 400);
      expect(window).toContain('requiredRole="product_admin"');
    });
  });

  describe('AC#2 — axe-core zero violations', () => {
    it('list page (with rows): zero violations', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/customer-health']}>
          <Routes>
            <Route path="/console/customer-health" element={<CustomerHealth />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('customer-health-page')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('drill-in page: zero violations', async () => {
      const { container } = render(
        <MemoryRouter
          initialEntries={[
            `/console/customer-health/${TENANT_A}?productId=${PRODUCT_A}`,
          ]}
        >
          <Routes>
            <Route
              path="/console/customer-health/:tenantId"
              element={<CustomerHealthDetail />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('customer-health-detail-page'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#3 — meta.thresholds propagation (badge derivation follows the BE)', () => {
    it('BE renders healthBadge=red at score 0.85 (default 0.7 threshold)', async () => {
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/console/customer-health']}>
            <Routes>
              <Route path="/console/customer-health" element={<CustomerHealth />} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('customer-health-badge-red'),
        ).toBeInTheDocument();
      });
    });

    it('when BE returns yellow badge for score 0.85 under a raised threshold, FE renders yellow', async () => {
      // Simulates the threshold-mutation flow: settings PUT raises
      // customer_health_red_threshold to 0.9 → BE re-derives the same
      // 0.85 score as yellow → FE mirrors it faithfully (the badge is
      // BE-authoritative; FE does not re-derive from meta.thresholds).
      mockRoutes({
        listPayload: {
          ...LIST_PAYLOAD,
          rows: [{ ...LIST_PAYLOAD.rows[0]!, healthBadge: 'yellow' }],
          meta: { thresholds: { red: 0.9, yellow: 0.4, staleDays: 14 } },
        },
      });
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/console/customer-health']}>
            <Routes>
              <Route path="/console/customer-health" element={<CustomerHealth />} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('customer-health-badge-yellow'),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId('customer-health-badge-red'),
      ).toBeNull();
    });
  });
});
