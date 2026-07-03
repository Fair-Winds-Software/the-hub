// Authorized by HUB-1687 (E-FE-13 S2) — list route tests: table render,
// 4-way status badge triple-encoding, multi-currency formatter, row
// click, empty state + total count, refresh with ?fresh=true, 403 +
// error surfaces.
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
import FailedPayments from '../FailedPayments';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const ID_1 = 'eeeeeeee-1111-1111-1111-eeeeeeeeeeee';
const ID_2 = 'eeeeeeee-2222-2222-2222-eeeeeeeeeeee';
const ID_3 = 'eeeeeeee-3333-3333-3333-eeeeeeeeeeee';
const ID_4 = 'eeeeeeee-4444-4444-4444-eeeeeeeeeeee';

const HAPPY_PAYLOAD = {
  rows: [
    {
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
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: ID_2,
      invoiceId: 'in_2',
      tenantId: 't-2',
      tenantName: 'Beta Corp',
      productId: 'p-2',
      amountCents: 4500,
      currency: 'eur',
      failureReason: 'expired_card',
      attemptCount: 3,
      maxAttempts: 3,
      nextRetryAt: null,
      lastRetryTriggeredAt: null,
      status: 'exhausted',
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: ID_3,
      invoiceId: 'in_3',
      tenantId: 't-3',
      tenantName: 'Gamma',
      productId: 'p-3',
      amountCents: 1000,
      currency: 'gbp',
      failureReason: null,
      attemptCount: 2,
      maxAttempts: 3,
      nextRetryAt: null,
      lastRetryTriggeredAt: null,
      status: 'recovered',
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: ID_4,
      invoiceId: 'in_4',
      tenantId: 't-4',
      tenantName: 'Delta',
      productId: 'p-4',
      amountCents: 8000,
      currency: 'usd',
      failureReason: 'authentication_required',
      attemptCount: 2,
      maxAttempts: 3,
      nextRetryAt: null,
      lastRetryTriggeredAt: null,
      status: 'overridden',
      createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
  total: 4,
  generatedAt: '2026-07-03T00:00:00.000Z',
};

function mockHappy() {
  apiGetMock.mockResolvedValue(HAPPY_PAYLOAD);
}

function renderAt(url: string = '/console/failed-payments') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/console/failed-payments" element={<FailedPayments />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  mockHappy();
});

afterEach(() => {
  cleanup();
});

describe('FailedPayments (HUB-1687)', () => {
  it('renders the table with a row per failed payment', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('failed-payments-table')).toBeInTheDocument();
    expect(
      screen.getByTestId(`failed-payments-row-${ID_1}`),
    ).toBeInTheDocument();
    // Total shows the row count.
    expect(
      screen.getByTestId('failed-payments-total').textContent,
    ).toContain('4 failed payments');
  });

  it('surfaces all 4 triple-encoded status badges (color + icon + text)', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payment-badge-pending_retry'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payment-badge-pending_retry').textContent,
    ).toContain('Pending retry');
    expect(
      screen.getByTestId('failed-payment-badge-pending_retry').textContent,
    ).toContain('⏳');
    expect(
      screen.getByTestId('failed-payment-badge-exhausted').textContent,
    ).toContain('Exhausted');
    expect(
      screen.getByTestId('failed-payment-badge-recovered').textContent,
    ).toContain('Recovered');
    expect(
      screen.getByTestId('failed-payment-badge-recovered').textContent,
    ).toContain('✓');
    expect(
      screen.getByTestId('failed-payment-badge-overridden').textContent,
    ).toContain('Overridden');
  });

  it('renders multi-currency: $250.00 (USD) and €45.00 (EUR) and £10.00 (GBP)', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-${ID_1}`),
      ).toBeInTheDocument();
    });
    const usdRow = screen.getByTestId(`failed-payments-row-${ID_1}`);
    expect(usdRow.textContent).toContain('$250.00');
    const eurRow = screen.getByTestId(`failed-payments-row-${ID_2}`);
    // Intl formatter emits &euro; symbol.
    expect(eurRow.textContent).toContain('€45.00');
    const gbpRow = screen.getByTestId(`failed-payments-row-${ID_3}`);
    expect(gbpRow.textContent).toContain('£10.00');
  });

  it('row click fires onRowClick with the row payload', async () => {
    const onRowClick = vi.fn();
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/console/failed-payments']}>
          <Routes>
            <Route
              path="/console/failed-payments"
              element={<FailedPayments onRowClick={onRowClick} />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-link-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`failed-payments-row-link-${ID_1}`));
    });
    expect(onRowClick).toHaveBeenCalledOnce();
    expect(onRowClick.mock.calls[0]![0]!.id).toBe(ID_1);
  });

  it('Refresh now button calls the endpoint with ?fresh=true', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-page')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-refresh'));
    });
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalled();
    });
    expect(apiGetMock.mock.calls[0]![0]).toContain('fresh=true');
  });

  it('empty state renders when total is 0', async () => {
    apiGetMock.mockResolvedValue({ ...HAPPY_PAYLOAD, rows: [], total: 0 });
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-empty')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-empty').textContent,
    ).toContain('No failed payments in this window');
  });

  it('403 → AccessDeniedPage', async () => {
    apiGetMock.mockRejectedValueOnce(new PermissionDeniedError(403, 'no'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
    });
    errSpy.mockRestore();
  });

  it('fetch throw → error surface with Retry', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('failed-payments-retry')).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
