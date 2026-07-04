// Authorized by HUB-1690 (E-FE-13 S5) — retry action: two-step confirm
// wired through HUB-1575 ConfirmDestructive, 409 in-flight → distinct
// error copy, generic error → generic copy, success → onRetrySuccess
// fires (parent closes drawer + refetches list).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { FailedPaymentsRetryAction } from '../FailedPaymentsRetryAction';
import { ApiError } from '../../../lib/errors';

const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

const INVOICE_ID = 'eeeeeeee-1111-1111-1111-eeeeeeeeeeee';

beforeEach(() => {
  apiPostMock.mockReset();
});

afterEach(() => {
  cleanup();
});

async function openConfirmAndClickConfirm(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('failed-payments-retry-trigger'));
  });
  // ConfirmDestructive renders an alertdialog; scope the confirm click
  // inside it so it doesn't collide with the trigger button (same label).
  const dialog = await screen.findByRole('alertdialog');
  const confirmBtn = within(dialog).getByRole('button', {
    name: /^Retry now$/i,
  });
  await act(async () => {
    fireEvent.click(confirmBtn);
  });
}

describe('FailedPaymentsRetryAction (HUB-1690)', () => {
  it('trigger button renders with the retry copy', () => {
    render(
      <FailedPaymentsRetryAction
        invoiceRowId={INVOICE_ID}
        amountCents={25000}
        currency="usd"
        onRetrySuccess={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId('failed-payments-retry-trigger'),
    ).toBeInTheDocument();
  });

  it('two-step confirm — success → onRetrySuccess fires + POST hit', async () => {
    apiPostMock.mockResolvedValue({
      attemptCount: 2,
      lastRetryTriggeredAt: '2026-07-03T00:00:00.500Z',
      stripeStatus: 'paid',
    });
    const onRetrySuccess = vi.fn();
    render(
      <FailedPaymentsRetryAction
        invoiceRowId={INVOICE_ID}
        amountCents={25000}
        currency="usd"
        onRetrySuccess={onRetrySuccess}
      />,
    );
    await openConfirmAndClickConfirm();
    await waitFor(() => {
      expect(onRetrySuccess).toHaveBeenCalledOnce();
    });
    expect(apiPostMock).toHaveBeenCalledOnce();
    expect(apiPostMock.mock.calls[0]![0]).toBe(
      `/api/v1/admin/billing/failed-payments/${INVOICE_ID}/retry`,
    );
  });

  it('409 retry_in_flight → distinct "already pending" copy in-place', async () => {
    apiPostMock.mockRejectedValue(new ApiError(409, 'retry_in_flight'));
    const onRetrySuccess = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <FailedPaymentsRetryAction
        invoiceRowId={INVOICE_ID}
        amountCents={25000}
        currency="usd"
        onRetrySuccess={onRetrySuccess}
      />,
    );
    await openConfirmAndClickConfirm();
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-retry-error'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-retry-error').textContent,
    ).toContain('already pending');
    expect(onRetrySuccess).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('generic error → generic error copy', async () => {
    apiPostMock.mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <FailedPaymentsRetryAction
        invoiceRowId={INVOICE_ID}
        amountCents={25000}
        currency="usd"
        onRetrySuccess={vi.fn()}
      />,
    );
    await openConfirmAndClickConfirm();
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-retry-error'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-retry-error').textContent,
    ).toContain('boom');
    errSpy.mockRestore();
  });
});
