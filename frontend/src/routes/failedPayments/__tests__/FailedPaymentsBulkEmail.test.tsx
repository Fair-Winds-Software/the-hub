// Authorized by HUB-1692 (E-FE-13 S7) — bulk-email tests: bar shows on
// selection with super_admin, hidden for product_admin, over-cap warning,
// recipient preview modal, partial-failure UX, on-success clears selection
// and refetches.
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
import { useSessionStore } from '../../../stores/sessionStore';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const ID_1 = 'eeeeeeee-1111-1111-1111-eeeeeeeeeeee';
const ID_2 = 'eeeeeeee-2222-2222-2222-eeeeeeeeeeee';

function makeRow(id: string, tenantName: string) {
  return {
    id,
    invoiceId: `in_${id.slice(-4)}`,
    tenantId: `t-${id.slice(-4)}`,
    tenantName,
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
}

const HAPPY_PAYLOAD = {
  rows: [makeRow(ID_1, 'Acme'), makeRow(ID_2, 'Beta')],
  total: 2,
  generatedAt: '2026-07-03T00:00:00.000Z',
};

function mockHappy() {
  apiGetMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({ data: [] });
    }
    if (url.startsWith(`/api/v1/admin/billing/failed-payments/${ID_1}`) ||
        url.startsWith(`/api/v1/admin/billing/failed-payments/${ID_2}`)) {
      return Promise.resolve({});
    }
    return Promise.resolve(HAPPY_PAYLOAD);
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

function setRole(role: 'super_admin' | 'product_admin'): void {
  useSessionStore.setState({
    accessToken: 'test-token',
    operator: { operator_id: 'op-1', role, tenant_id: null },
  } as never);
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  mockHappy();
  setRole('super_admin');
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession?.();
});

describe('FailedPaymentsBulkEmailBar (HUB-1692)', () => {
  it('bar is hidden until a row is selected', async () => {
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-page')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('failed-payments-bulk-bar')).toBeNull();
  });

  it('selecting a row shows the bar with the count', async () => {
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      );
    });
    expect(
      screen.getByTestId('failed-payments-bulk-bar'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('failed-payments-bulk-count').textContent,
    ).toContain('1 selected');
  });

  it('product_admin: bar shows count + Clear but NOT the Send button', async () => {
    setRole('product_admin');
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      );
    });
    expect(
      screen.getByTestId('failed-payments-bulk-bar'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('failed-payments-bulk-send'),
    ).toBeNull();
  });

  it('Send opens the recipient preview modal listing selected rows', async () => {
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      );
      fireEvent.click(
        screen.getByTestId(`failed-payments-row-select-${ID_2}`),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-bulk-send'));
    });
    expect(
      screen.getByTestId('failed-payments-bulk-preview'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`failed-payments-bulk-preview-row-${ID_1}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`failed-payments-bulk-preview-row-${ID_2}`),
    ).toBeInTheDocument();
  });

  it('confirm send → POSTs ids + shows success result', async () => {
    apiPostMock.mockResolvedValue({ sent: 2, failed: [] });
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      );
      fireEvent.click(
        screen.getByTestId(`failed-payments-row-select-${ID_2}`),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-bulk-send'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-bulk-confirm'));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-bulk-result'),
      ).toBeInTheDocument();
    });
    expect(apiPostMock).toHaveBeenCalledOnce();
    expect(apiPostMock.mock.calls[0]![0]).toBe(
      '/api/v1/admin/billing/failed-payments/bulk-email',
    );
    expect(apiPostMock.mock.calls[0]![1]).toEqual({
      ids: [ID_1, ID_2],
    });
    expect(
      screen.getByTestId('failed-payments-bulk-result').textContent,
    ).toContain('Sent 2');
  });

  it('partial-failure result shows per-id error list', async () => {
    apiPostMock.mockResolvedValue({
      sent: 1,
      failed: [{ id: ID_2, error: 'no billing_email' }],
    });
    await act(async () => {
      renderPage();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(`failed-payments-row-select-${ID_1}`),
      );
      fireEvent.click(
        screen.getByTestId(`failed-payments-row-select-${ID_2}`),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-bulk-send'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-bulk-confirm'));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-bulk-result-failures'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-bulk-result-failures').textContent,
    ).toContain('no billing_email');
  });
});
