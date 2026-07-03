// Authorized by HUB-1673 (E-FE-11 S5) — cross-cutting NFR verification
// for the Pricing Scenario Simulator:
//   1. Static-source RBAC assertion — /console/pricing-scenario wired
//      behind GuardedRoute(requiredRole="product_admin") in App.tsx.
//   2. axe-core zero violations on the page.
//   3. No-persistence E2E — remounting the route drops back to the
//      "Pick a product" empty state; the underlying inputs never
//      hydrate from localStorage / sessionStorage / URL.
//   4. RBAC/audit trail — the compute POST body carries product_id +
//      the input percentages so the BE audit writer captures them
//      (per HUB-1598 event_type='analytics.pricing_scenario_compute').
//
// Lighthouse CWV measurement of /console/pricing-scenario defers to
// Stage 4 per D-HUB-SCOPE-051 (same in-memory session-store constraint
// as every other post-auth route). CI continues to measure
// /console/login as the canonical cold-load proxy.
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
import PricingScenario from '../../PricingScenario';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const HAPPY_SCENARIO = {
  baseline: {
    snapshotAt: '2026-07-03T00:00:00.000Z',
    productId: PRODUCT_A,
    revenueLast30dCents: 500000,
    costLast30dCents: 100000,
    subscriptionCount: 20,
    elasticityCoefficient: -1,
    marginPct: 0.8,
  },
  scenario: {
    revenueCents: 525000,
    costCents: 100000,
    marginPct: 0.809,
    subscriptionCount: 19,
  },
  delta: {
    revenueCents: 25000,
    costCents: 0,
    marginPctPoints: 0.009,
    subscriptionCount: -1,
  },
  modelType: 'constant_elasticity',
  disclaimer: 'Scenario projections are advisory only...',
  baselineSnapshotAt: '2026-07-03T00:00:00.000Z',
  generatedAt: '2026-07-03T00:00:00.500Z',
};

function mockHappy() {
  apiGetMock.mockResolvedValue({
    data: [{ productId: PRODUCT_A, productName: 'Synapz' }],
  });
  apiPostMock.mockResolvedValue(HAPPY_SCENARIO);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/console/pricing-scenario']}>
      <Routes>
        <Route path="/console/pricing-scenario" element={<PricingScenario />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  mockHappy();
});

afterEach(() => {
  cleanup();
});

describe('Pricing Scenario NFR verification (HUB-1673)', () => {
  describe('AC#1 — RBAC: /console/pricing-scenario behind product_admin guard in App.tsx', () => {
    it('static source check: route requires product_admin', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const appPath = resolve(here, '../../../App.tsx');
      const source = readFileSync(appPath, 'utf8');
      const idx = source.indexOf('path="/console/pricing-scenario"');
      expect(idx).toBeGreaterThan(-1);
      const window = source.slice(idx, idx + 400);
      expect(window).toContain('requiredRole="product_admin"');
    });
  });

  describe('AC#2 — axe-core zero violations', () => {
    it('empty state (before product pick): zero violations', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/pricing-scenario']}>
          <Routes>
            <Route path="/console/pricing-scenario" element={<PricingScenario />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('pricing-scenario-page'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#3 — No-persistence contract (state does not survive remount)', () => {
    it('remounting the page returns to the empty "Pick a product" state', async () => {
      // First mount: pick a product + change a slider.
      const first = render(
        <MemoryRouter initialEntries={['/console/pricing-scenario']}>
          <Routes>
            <Route path="/console/pricing-scenario" element={<PricingScenario />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('pricing-scenario-page'),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId('pricing-scenario-product'), {
          target: { value: PRODUCT_A },
        });
      });
      await act(async () => {
        fireEvent.change(
          screen.getByTestId('pricing-scenario-price-slider'),
          { target: { value: '15' } },
        );
      });
      expect(
        screen.getByTestId('pricing-scenario-price-value').textContent,
      ).toBe('+15%');
      first.unmount();

      // Fresh mount: back to the empty state, no persisted slider value.
      render(
        <MemoryRouter initialEntries={['/console/pricing-scenario']}>
          <Routes>
            <Route path="/console/pricing-scenario" element={<PricingScenario />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('pricing-scenario-empty'),
        ).toBeInTheDocument();
      });
      // Product picker also back to placeholder — verifies nothing is
      // persisted in localStorage / URL / anywhere else.
      const select = screen.getByTestId(
        'pricing-scenario-product',
      ) as HTMLSelectElement;
      expect(select.value).toBe('');
    });
  });

  describe('AC#4 — Audit trail — POST body carries the inputs the BE audit-logs', () => {
    it('compute POST body includes product_id + both percentages (BE audit key set)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await act(async () => {
          renderPage();
        });
        await waitFor(() => {
          expect(
            screen.getByTestId('pricing-scenario-page'),
          ).toBeInTheDocument();
        });
        await act(async () => {
          fireEvent.change(screen.getByTestId('pricing-scenario-product'), {
            target: { value: PRODUCT_A },
          });
        });
        await act(async () => {
          fireEvent.change(
            screen.getByTestId('pricing-scenario-price-slider'),
            { target: { value: '12' } },
          );
        });
        await act(async () => {
          fireEvent.change(
            screen.getByTestId('pricing-scenario-churn-slider'),
            { target: { value: '5' } },
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        await waitFor(() => {
          expect(apiPostMock).toHaveBeenCalled();
        });
        const lastCall = apiPostMock.mock.calls[apiPostMock.mock.calls.length - 1]!;
        const body = lastCall[1] as Record<string, unknown>;
        expect(body).toEqual({
          product_id: PRODUCT_A,
          price_change_percent: 12,
          churn_assumption_percent: 5,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
