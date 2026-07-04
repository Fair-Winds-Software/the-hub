// Authorized by HUB-1689 (E-FE-13 S4) — drawer tests: open on row click,
// summary + retry history + Stripe deep-link render, empty history copy,
// close via SideDrawer restore.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import FailedPayments from '../../FailedPayments';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const ID_1 = 'eeeeeeee-1111-1111-1111-eeeeeeeeeeee';
const SUB_ID = 'sub_test_1';

const LIST_ROW = {
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

const DETAIL_PAYLOAD = {
  id: ID_1,
  invoiceId: 'in_1',
  stripeSubscriptionId: SUB_ID,
  tenantId: 't-1',
  tenantName: 'Acme',
  productId: 'p-1',
  amountCents: 25000,
  currency: 'usd',
  attemptCount: 1,
  maxAttempts: 3,
  nextRetryAt: null,
  lastRetryTriggeredAt: null,
  status: 'pending_retry',
  overriddenAt: null,
  overriddenBy: null,
  overrideReason: null,
  retryHistory: [
    {
      attemptAt: '2026-06-30T12:00:00.000Z',
      declineCode: 'insufficient_funds',
      errorMessage: 'Your card has insufficient funds.',
    },
  ],
};

function mockRoutes(detailOverride: unknown = DETAIL_PAYLOAD) {
  apiGetMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [] });
    }
    if (url.startsWith(`/api/v1/admin/billing/failed-payments/${ID_1}`)) {
      return Promise.resolve(detailOverride);
    }
    return Promise.resolve({
      rows: [LIST_ROW],
      total: 1,
      generatedAt: '2026-07-03T00:00:00.000Z',
    });
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/console/failed-payments']}>
      <Routes>
        <Route path="/console/failed-payments" element={<FailedPayments />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  mockRoutes();
});

afterEach(() => {
  cleanup();
});

describe('FailedPaymentsDrawer (HUB-1689)', () => {
  it('row click opens the drawer + fetches the drill-in payload', async () => {
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-link-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`failed-payments-row-link-${ID_1}`));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-drawer-summary'),
      ).toBeInTheDocument();
    });
    const detailCall = apiGetMock.mock.calls.find((c: unknown[]) =>
      (c[0] as string) ===
      `/api/v1/admin/billing/failed-payments/${ID_1}`,
    );
    expect(detailCall).toBeDefined();
  });

  it('drawer summary shows status + amount + attempts', async () => {
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-link-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`failed-payments-row-link-${ID_1}`));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-drawer-summary'),
      ).toBeInTheDocument();
    });
    const summary = screen.getByTestId('failed-payments-drawer-summary');
    expect(summary.textContent).toContain('Pending retry');
    expect(summary.textContent).toContain('$250.00');
    expect(summary.textContent).toContain('1 of 3');
  });

  it('retry history renders per event with decline code + message', async () => {
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-link-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`failed-payments-row-link-${ID_1}`));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-drawer-history-0'),
      ).toBeInTheDocument();
    });
    const evt = screen.getByTestId('failed-payments-drawer-history-0');
    expect(evt.textContent).toContain('insufficient_funds');
    expect(evt.textContent).toContain('insufficient funds');
  });

  it('empty retry history renders "No previous retry events recorded"', async () => {
    mockRoutes({ ...DETAIL_PAYLOAD, retryHistory: [] });
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-link-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`failed-payments-row-link-${ID_1}`));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-drawer-history'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-drawer-history').textContent,
    ).toContain('No previous retry events recorded');
  });

  it('View in Stripe link deep-links to dashboard.stripe.com/subscriptions/<subId> in new tab', async () => {
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-link-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`failed-payments-row-link-${ID_1}`));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-drawer-stripe-link'),
      ).toBeInTheDocument();
    });
    const link = screen.getByTestId('failed-payments-drawer-stripe-link');
    expect(link.getAttribute('href')).toBe(
      `https://dashboard.stripe.com/subscriptions/${SUB_ID}`,
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('overridden rows show override metadata block', async () => {
    mockRoutes({
      ...DETAIL_PAYLOAD,
      status: 'overridden',
      overriddenAt: '2026-07-02T10:00:00.000Z',
      overriddenBy: 'op-2',
      overrideReason: 'Customer contacted; will pay next cycle.',
    });
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-link-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`failed-payments-row-link-${ID_1}`));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-drawer-override'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-drawer-override').textContent,
    ).toContain('op-2');
    expect(
      screen.getByTestId('failed-payments-drawer-override').textContent,
    ).toContain('next cycle');
  });
});
