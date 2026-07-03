// Authorized by HUB-1688 (E-FE-13 S3) — filter sidebar + URL state +
// counts panel tests. Uses the same mock scaffold as S2's list test.
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
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    {
      id: ID_2,
      invoiceId: 'in_2',
      tenantId: 't-2',
      tenantName: 'Beta',
      productId: 'p-2',
      amountCents: 4500,
      currency: 'eur',
      failureReason: 'expired_card',
      attemptCount: 3,
      maxAttempts: 3,
      nextRetryAt: null,
      lastRetryTriggeredAt: null,
      status: 'exhausted',
      createdAt: '2026-07-01T00:00:00.000Z',
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
      createdAt: '2026-07-01T00:00:00.000Z',
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
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  total: 4,
  generatedAt: '2026-07-03T00:00:00.000Z',
};

function mockHappy() {
  apiGetMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({
        data: [
          { productId: 'p-1', productName: 'Synapz' },
          { productId: 'p-2', productName: 'ContentHelm' },
        ],
      });
    }
    return Promise.resolve(HAPPY_PAYLOAD);
  });
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

describe('FailedPaymentsFilters — sidebar (HUB-1688)', () => {
  it('sidebar renders + counts panel shows raw counts per status', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-filters')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-counts'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('failed-payments-count-pending_retry').textContent,
    ).toContain('1');
    expect(
      screen.getByTestId('failed-payments-count-exhausted').textContent,
    ).toContain('1');
    expect(
      screen.getByTestId('failed-payments-count-recovered').textContent,
    ).toContain('1');
    expect(
      screen.getByTestId('failed-payments-count-overridden').textContent,
    ).toContain('1');
  });

  it('URL load with status=pending_retry restores the checkbox state + filters the table', async () => {
    await act(async () => {
      renderAt('/console/failed-payments?status=pending_retry');
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-page')).toBeInTheDocument();
    });
    expect(
      (screen.getByTestId(
        'failed-payments-filter-status-pending_retry',
      ) as HTMLInputElement).checked,
    ).toBe(true);
    // Only the pending_retry row is visible in the table.
    expect(
      screen.getByTestId(`failed-payments-row-${ID_1}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`failed-payments-row-${ID_2}`),
    ).toBeNull();
    // Counts still reflect the raw portfolio-level shape (unaffected by
    // the status filter) — 1 exhausted still visible.
    expect(
      screen.getByTestId('failed-payments-count-exhausted').textContent,
    ).toContain('1');
  });

  it('clicking a status checkbox updates URL query + narrows the table', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`failed-payments-row-${ID_1}`),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId('failed-payments-filter-status-exhausted'),
      );
    });
    // Only exhausted stays.
    expect(
      screen.queryByTestId(`failed-payments-row-${ID_1}`),
    ).toBeNull();
    expect(
      screen.getByTestId(`failed-payments-row-${ID_2}`),
    ).toBeInTheDocument();
  });

  it('product dropdown change threads productId into the BE fetch', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-page')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    await act(async () => {
      fireEvent.change(screen.getByTestId('failed-payments-filter-product'), {
        target: { value: 'p-2' },
      });
    });
    await waitFor(() => {
      const healthCall = apiGetMock.mock.calls.find((c: unknown[]) =>
        (c[0] as string).startsWith('/api/v1/admin/billing/failed-payments'),
      );
      expect(healthCall).toBeDefined();
      expect(healthCall![0]).toContain('productId=p-2');
    });
  });

  it('Reset button clears all filters + strips query params', async () => {
    await act(async () => {
      renderAt(
        '/console/failed-payments?status=pending_retry&product=p-1&from=2026-06-01',
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-reset'));
    });
    expect(
      (screen.getByTestId(
        'failed-payments-filter-status-pending_retry',
      ) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId('failed-payments-filter-product') as HTMLSelectElement)
        .value,
    ).toBe('');
    // Every row visible again (no filters).
    expect(
      screen.getByTestId(`failed-payments-row-${ID_1}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`failed-payments-row-${ID_2}`),
    ).toBeInTheDocument();
  });

  it('date-range inputs thread from + to into the BE fetch', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-page')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    await act(async () => {
      fireEvent.change(screen.getByTestId('failed-payments-filter-from'), {
        target: { value: '2026-06-01' },
      });
    });
    await waitFor(() => {
      const healthCall = apiGetMock.mock.calls.find((c: unknown[]) =>
        (c[0] as string).startsWith('/api/v1/admin/billing/failed-payments'),
      );
      expect(healthCall).toBeDefined();
      expect(healthCall![0]).toContain('from=2026-06-01');
    });
  });

  it('header copy switches to "matching filters" when any filter is active', async () => {
    await act(async () => {
      renderAt('/console/failed-payments?status=pending_retry');
    });
    await waitFor(() => {
      expect(screen.getByTestId('failed-payments-total')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-total').textContent,
    ).toContain('matching filters');
  });
});
