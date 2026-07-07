// Authorized by HUB-1737 + HUB-1738 + HUB-1739 (E-V2-PP-2 S8/S9/S10, HUB-1726, HUB-1701) —
// Frontend tests for the three custom-quote UIs. Focused on rendering + interaction; the
// happy-path API contract is verified in the backend integration test HUB-1740.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CustomQuotes } from '../CustomQuotes';
import NewCustomQuote, { validateNewQuote } from '../NewCustomQuote';
import CustomQuoteDetail from '../CustomQuoteDetail';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const PRODUCT_ID = '00000000-0000-0000-0000-000000000002';
const OPERATOR_ID_A = '00000000-0000-0000-0000-00000000000a';
const OPERATOR_ID_B = '00000000-0000-0000-0000-00000000000b';

const QUOTE_PENDING = {
  id: 'quote-pending-1',
  tenant_id: TENANT_ID,
  product_id: PRODUCT_ID,
  operator_id: OPERATOR_ID_A,
  status: 'pending' as const,
  total_cents: 500000,
  currency: 'USD',
  expires_at: '2027-01-01T00:00:00.000Z',
  invoice_id: null,
  invoiced_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
});

afterEach(() => cleanup());

// ── HUB-1738 (S9): CustomQuotes list route ────────────────────────────────
describe('HUB-1738 (S9): CustomQuotes list', () => {
  it('defaults status filter to pending + renders quote row (AC 2)', async () => {
    apiGetMock.mockResolvedValue({ data: [QUOTE_PENDING], total: 1, page: 1, pageSize: 50 });
    render(
      <MemoryRouter>
        <CustomQuotes tenantId={TENANT_ID} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=pending');
    expect(await screen.findByTestId(`quote-row-${QUOTE_PENDING.id}`)).toBeInTheDocument();
    // Currency formatting.
    expect(screen.getByText('$5,000.00')).toBeInTheDocument();
  });

  it('status filter change refetches with new param', async () => {
    apiGetMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 });
    render(
      <MemoryRouter>
        <CustomQuotes tenantId={TENANT_ID} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    apiGetMock.mockClear();
    fireEvent.change(screen.getByTestId('quote-status-filter'), { target: { value: 'approved' } });
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect((apiGetMock.mock.calls[0]![0] as string)).toContain('status=approved');
  });

  it('shows empty state when no quotes returned', async () => {
    apiGetMock.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 });
    render(
      <MemoryRouter>
        <CustomQuotes tenantId={TENANT_ID} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('quotes-empty')).toBeInTheDocument();
  });

  it('shows deny state on 403 (PermissionDeniedError branch)', async () => {
    const { PermissionDeniedError } = await import('../../lib/errors');
    apiGetMock.mockRejectedValueOnce(new PermissionDeniedError(403, 'nope'));
    render(
      <MemoryRouter>
        <CustomQuotes tenantId={TENANT_ID} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('quotes-denied')).toBeInTheDocument();
  });
});

// ── HUB-1737 (S8): NewCustomQuote form ────────────────────────────────────
describe('HUB-1737 (S8): NewCustomQuote form', () => {
  it('renders one initial line-item row + running total updates live (AC 4)', () => {
    render(
      <MemoryRouter>
        <NewCustomQuote tenantId={TENANT_ID} productId={PRODUCT_ID} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('quote-line-desc-0')).toBeInTheDocument();
    // Enter a quantity + unit amount; the running total should update.
    fireEvent.change(screen.getByTestId('quote-line-qty-0'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('quote-line-amount-0'), { target: { value: '10000' } });
    fireEvent.change(screen.getByTestId('quote-line-desc-0'), { target: { value: 'Consulting hours' } });
    expect(screen.getByTestId('quote-running-total').textContent).toContain('$300.00');
  });

  it('add row + remove row work', () => {
    render(
      <MemoryRouter>
        <NewCustomQuote tenantId={TENANT_ID} productId={PRODUCT_ID} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('quote-add-line'));
    expect(screen.getByTestId('quote-line-desc-1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quote-line-remove-1'));
    expect(screen.queryByTestId('quote-line-desc-1')).toBeNull();
  });

  it('submit sends payload matching the API contract (AC 5)', async () => {
    apiPostMock.mockResolvedValueOnce({ id: 'quote-new-1' });
    render(
      <MemoryRouter initialEntries={['/console/billing/quotes/new']}>
        <Routes>
          <Route
            path="/console/billing/quotes/new"
            element={<NewCustomQuote tenantId={TENANT_ID} productId={PRODUCT_ID} />}
          />
          <Route path="/console/billing/quotes/:id" element={<div>Detail</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('quote-line-desc-0'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('quote-line-qty-0'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('quote-line-amount-0'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('quote-submit'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/api/v1/admin/billing/quotes',
      expect.objectContaining({
        tenant_id: TENANT_ID,
        product_id: PRODUCT_ID,
        line_items: [{ description: 'X', quantity: 2, unit_amount_cents: 500 }],
      }),
    ));
  });
});

// ── validateNewQuote pure function ────────────────────────────────────────
describe('validateNewQuote', () => {
  const valid = [{ description: 'X', quantity: '1', unit_amount_cents: '100' }];

  it('accepts a valid draft', () => {
    expect(validateNewQuote(valid, '')).toEqual({});
  });

  it('rejects empty line items', () => {
    expect(validateNewQuote([], '')).toHaveProperty('line_items');
  });

  it('rejects missing description', () => {
    expect(validateNewQuote([{ description: '', quantity: '1', unit_amount_cents: '100' }], ''))
      .toHaveProperty('line_items[0].description');
  });

  it('rejects quantity < 1', () => {
    expect(validateNewQuote([{ description: 'x', quantity: '0', unit_amount_cents: '100' }], ''))
      .toHaveProperty('line_items[0].quantity');
  });

  it('rejects past expires_at', () => {
    expect(validateNewQuote(valid, '2020-01-01')).toHaveProperty('expires_at');
  });
});

// ── HUB-1739 (S10): CustomQuoteDetail approve/reject action ───────────────
describe('HUB-1739 (S10): CustomQuoteDetail', () => {
  const detail = {
    ...QUOTE_PENDING,
    line_items: [
      { id: 'li-1', description: 'A', quantity: 2, unit_amount_cents: 25000, sort_order: 0 },
    ],
    approvals: [],
  };

  function mount(operatorId: string): void {
    apiGetMock.mockResolvedValue(detail);
    render(
      <MemoryRouter initialEntries={[`/console/billing/quotes/${detail.id}`]}>
        <Routes>
          <Route
            path="/console/billing/quotes/:id"
            element={<CustomQuoteDetail currentOperatorId={operatorId} />}
          />
          <Route path="/console/billing/quotes" element={<div>List</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('hides Approve/Reject buttons for the creator (AC 2 two-role)', async () => {
    mount(OPERATOR_ID_A); // same as quote.operator_id
    await waitFor(() => expect(screen.getByTestId('quote-detail-page')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-approve-button')).toBeNull();
    expect(screen.queryByTestId('quote-reject-button')).toBeNull();
    expect(screen.getByTestId('quote-self-notice')).toBeInTheDocument();
  });

  it('shows Approve/Reject for a different operator (AC 2 happy path)', async () => {
    mount(OPERATOR_ID_B); // different operator
    await waitFor(() => expect(screen.getByTestId('quote-detail-page')).toBeInTheDocument());
    expect(screen.getByTestId('quote-approve-button')).toBeInTheDocument();
    expect(screen.getByTestId('quote-reject-button')).toBeInTheDocument();
  });

  it('approve submit posts with reason (AC 3)', async () => {
    mount(OPERATOR_ID_B);
    await waitFor(() => screen.getByTestId('quote-approve-button'));
    fireEvent.click(screen.getByTestId('quote-approve-button'));
    expect(screen.getByTestId('decision-modal')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('decision-reason'), {
      target: { value: 'This is a valid reason with more than twenty characters for approval.' },
    });
    apiPostMock.mockResolvedValueOnce({});
    fireEvent.click(screen.getByTestId('decision-submit'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      `/api/v1/admin/billing/quotes/${detail.id}/approve`,
      { reason: 'This is a valid reason with more than twenty characters for approval.' },
    ));
  });

  it('submit disabled when reason < 20 chars (AC 3)', async () => {
    mount(OPERATOR_ID_B);
    await waitFor(() => screen.getByTestId('quote-approve-button'));
    fireEvent.click(screen.getByTestId('quote-approve-button'));
    fireEvent.change(screen.getByTestId('decision-reason'), { target: { value: 'too short' } });
    expect(screen.getByTestId('decision-submit')).toBeDisabled();
  });
});
