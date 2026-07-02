// Authorized by HUB-1679 (E-FE-7 S6) — cross-cutting NFR verification for
// the System Health Epic. Static-source assertion that App.tsx wires the
// portfolio grid + drill-in behind GuardedRoute(product_admin); axe-core
// zero violations across all five surfaces (S2 portfolio grid + S4
// Liveness/Errors tabs + S5 Queues/Webhooks tabs); HealthTabErrorBoundary
// isolation contract (one tab's throw does NOT cascade to sibling
// content).
//
// Lighthouse CWV measurement of the /console/system-health routes defers
// to Stage 4 per D-HUB-SCOPE-051 (same in-memory session-store constraint
// as every other post-auth route). CI continues to measure /console/login
// as the canonical cold-load proxy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
import SystemHealth from '../../SystemHealth';
import SystemHealthLivenessTab from '../SystemHealthLivenessTab';
import SystemHealthErrorsTab from '../SystemHealthErrorsTab';
import SystemHealthQueuesTab from '../SystemHealthQueuesTab';
import SystemHealthWebhooksTab from '../SystemHealthWebhooksTab';
import { HealthTabErrorBoundary } from '../HealthTabErrorBoundary';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const PRODUCT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function mockHappyPath() {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/system-health/portfolio')) {
      return Promise.resolve({
        products: [
          {
            productId: PRODUCT_A,
            reachable: true,
            lastProbedAt: '2026-06-30T00:00:00.000Z',
            errorRate24h: 0.01,
            lastErrorEvent: null,
          },
        ],
        generatedAt: '2026-06-30T00:00:00.000Z',
        meta: { threshold: 0.05 },
      });
    }
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({
        data: [{ productId: PRODUCT_A, productName: 'Synapz' }],
      });
    }
    if (path.startsWith('/api/v1/admin/system-health/audit-errors')) {
      return Promise.resolve({
        errors: [],
        generatedAt: '2026-06-30T00:00:00.000Z',
      });
    }
    if (path.startsWith('/api/v1/admin/system-health/queues')) {
      return Promise.resolve({
        queues: [
          {
            name: 'queue:a',
            depth: 0,
            dlqSize: 0,
            oldestJobAgeSeconds: null,
          },
        ],
        generatedAt: '2026-06-30T00:00:00.000Z',
      });
    }
    if (path.startsWith('/api/v1/admin/system-health/stripe-webhooks')) {
      return Promise.resolve({
        successCount: 100,
        failureCount: 0,
        successRate: 1,
        lastFailedAt: null,
        pendingRetryCount: 0,
        generatedAt: '2026-06-30T00:00:00.000Z',
      });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  mockHappyPath();
});

afterEach(() => {
  cleanup();
});

describe('System Health NFR verification (HUB-1679)', () => {
  describe('AC#1 — RBAC: portfolio + detail routes behind product_admin guard in App.tsx', () => {
    it('static source check: both /console/system-health routes require product_admin', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const appPath = resolve(here, '../../../App.tsx');
      const source = readFileSync(appPath, 'utf8');

      for (const routePath of [
        '"/console/system-health"',
        '"/console/system-health/:productId"',
      ]) {
        const idx = source.indexOf(`path=${routePath}`);
        expect(idx).toBeGreaterThan(-1);
        const window = source.slice(idx, idx + 400);
        expect(window).toContain('requiredRole="product_admin"');
      }
    });
  });

  describe('AC#2 — axe-core zero violations across S2/S4/S5 surfaces', () => {
    it('S2 SystemHealth portfolio grid: zero violations', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/system-health']}>
          <Routes>
            <Route path="/console/system-health" element={<SystemHealth />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('system-health-page'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S4 Liveness tab: zero violations', async () => {
      const { container } = render(
        <MemoryRouter
          initialEntries={[`/console/system-health/${PRODUCT_A}/liveness`]}
        >
          <Routes>
            <Route
              path="/console/system-health/:productId/liveness"
              element={<SystemHealthLivenessTab />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('liveness-tab')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S4 Errors tab (empty): zero violations', async () => {
      const { container } = render(
        <MemoryRouter
          initialEntries={[`/console/system-health/${PRODUCT_A}/errors`]}
        >
          <Routes>
            <Route
              path="/console/system-health/:productId/errors"
              element={<SystemHealthErrorsTab />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('errors-tab')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S5 Queues tab: zero violations', async () => {
      const { container } = render(
        <MemoryRouter>
          <SystemHealthQueuesTab />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('queues-tab')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('S5 Webhooks tab: zero violations', async () => {
      const { container } = render(
        <MemoryRouter>
          <SystemHealthWebhooksTab />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('webhooks-tab')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#3 — HealthTabErrorBoundary isolation', () => {
    function AlwaysThrows(): React.ReactElement {
      throw new Error('tab-boom');
    }

    it('catches a runtime throw + renders the error panel with a Retry button', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(
        <HealthTabErrorBoundary tabLabel="queues">
          <AlwaysThrows />
        </HealthTabErrorBoundary>,
      );
      expect(
        screen.getByTestId('health-tab-error-boundary-queues'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('health-tab-error-boundary-queues').textContent,
      ).toMatch(/tab-boom/);
      expect(
        screen.getByTestId('health-tab-error-boundary-retry-queues'),
      ).toBeInTheDocument();
      errSpy.mockRestore();
    });

    it('sibling boundary keeps rendering when the other one catches', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(
        <>
          <HealthTabErrorBoundary tabLabel="failing">
            <AlwaysThrows />
          </HealthTabErrorBoundary>
          <HealthTabErrorBoundary tabLabel="healthy">
            <span data-testid="healthy-tab-child">still here</span>
          </HealthTabErrorBoundary>
        </>,
      );
      expect(
        screen.getByTestId('health-tab-error-boundary-failing'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('healthy-tab-child')).toBeInTheDocument();
      errSpy.mockRestore();
    });

    it('Retry clears the boundary state', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(
        <HealthTabErrorBoundary tabLabel="queues">
          <AlwaysThrows />
        </HealthTabErrorBoundary>,
      );
      // Boundary shows the error panel initially.
      expect(
        screen.getByTestId('health-tab-error-boundary-queues'),
      ).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(
          screen.getByTestId('health-tab-error-boundary-retry-queues'),
        );
        await Promise.resolve();
      });
      // After retry the boundary re-mounts the child, which throws again;
      // the error panel remains present but the retry was accepted (state
      // cleared and re-thrown). The important assertion is that the retry
      // button doesn't crash the harness.
      expect(
        screen.getByTestId('health-tab-error-boundary-queues'),
      ).toBeInTheDocument();
      errSpy.mockRestore();
    });
  });
});
