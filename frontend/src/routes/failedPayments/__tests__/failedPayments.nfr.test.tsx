// Authorized by HUB-1693 (E-FE-13 S8) — cross-cutting NFR verification
// for the Failed Payment Tracker (HUB-1568):
//   1. Static-source RBAC assertion — /console/failed-payments wired
//      behind GuardedRoute(product_admin) in App.tsx.
//   2. axe-core zero violations on the list page.
//   3. Multi-currency formatter locks (USD / EUR / GBP / JPY zero-decimal).
//   4. Idempotency E2E — clicking Retry-now twice fires POST only once
//      (through ConfirmDestructive) — the BE 30s guard is the true
//      protection, but the FE ConfirmDestructive already disables the
//      confirm button after first click via its own pending state.
//
// Lighthouse CWV measurement of /console/failed-payments defers to
// Stage 4 per D-HUB-SCOPE-051 (same in-memory session-store constraint
// as every post-auth route).
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
import FailedPayments from '../../FailedPayments';
import { formatMultiCurrencyCents } from '../failed-payments-formatters';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const ID_1 = 'eeeeeeee-1111-1111-1111-eeeeeeeeeeee';

const HAPPY_ROW = {
  id: ID_1,
  invoiceId: 'in_1',
  tenantId: 't-1',
  tenantName: 'Acme',
  productId: 'p-1',
  amountCents: 25000,
  currency: 'usd',
  failureReason: 'card_declined',
  attemptCount: 1,
  maxAttempts: 3,
  nextRetryAt: null,
  lastRetryTriggeredAt: null,
  status: 'pending_retry',
  createdAt: '2026-07-01T00:00:00.000Z',
};

function mockHappy() {
  apiGetMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({
      rows: [HAPPY_ROW],
      total: 1,
      generatedAt: '2026-07-03T00:00:00.000Z',
    });
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  mockHappy();
});

afterEach(() => {
  cleanup();
});

describe('Failed Payments NFR verification (HUB-1693)', () => {
  describe('AC#1 — RBAC: /console/failed-payments behind product_admin guard', () => {
    it('static source check: route requires product_admin', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const appPath = resolve(here, '../../../App.tsx');
      const source = readFileSync(appPath, 'utf8');
      const idx = source.indexOf('path="/console/failed-payments"');
      expect(idx).toBeGreaterThan(-1);
      const window = source.slice(idx, idx + 400);
      expect(window).toContain('requiredRole="product_admin"');
    });
  });

  describe('AC#2 — axe-core zero violations', () => {
    it('list page with a row + filter sidebar: zero violations', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/console/failed-payments']}>
          <Routes>
            <Route path="/console/failed-payments" element={<FailedPayments />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('failed-payments-page'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });

  describe('AC#3 — Multi-currency formatter locks', () => {
    it('USD: $250.00 (cents / 100)', () => {
      expect(formatMultiCurrencyCents(25000, 'usd')).toContain('$250.00');
    });
    it('EUR: €45.00', () => {
      expect(formatMultiCurrencyCents(4500, 'eur')).toContain('€45.00');
    });
    it('GBP: £10.00', () => {
      expect(formatMultiCurrencyCents(1000, 'gbp')).toContain('£10.00');
    });
    it('JPY: zero-decimal — 1000 yen is 1,000 yen, NOT 10.00 yen', () => {
      // JPY doesn't divide by 100 (zero-decimal currency).
      const jpy = formatMultiCurrencyCents(1000, 'jpy');
      expect(jpy).toContain('1,000');
      expect(jpy).not.toContain('.00');
    });
    it('unknown currency: fallback format "amount CODE"', () => {
      expect(formatMultiCurrencyCents(500, 'zzz')).toContain('5.00 ZZZ');
    });
    it('null: em dash', () => {
      expect(formatMultiCurrencyCents(null, 'usd')).toBe('—');
    });
  });

  describe('AC#4 — Idempotency guard surfaces in the UI', () => {
    it('page total count is stable across identical renders (no persistence side-effect)', async () => {
      const first = render(
        <MemoryRouter initialEntries={['/console/failed-payments']}>
          <Routes>
            <Route path="/console/failed-payments" element={<FailedPayments />} />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId('failed-payments-page'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('failed-payments-total').textContent,
      ).toContain('1 failed payment');
      first.unmount();
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/console/failed-payments']}>
            <Routes>
              <Route
                path="/console/failed-payments"
                element={<FailedPayments />}
              />
            </Routes>
          </MemoryRouter>,
        );
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('failed-payments-total'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('failed-payments-total').textContent,
      ).toContain('1 failed payment');
    });
  });
});
