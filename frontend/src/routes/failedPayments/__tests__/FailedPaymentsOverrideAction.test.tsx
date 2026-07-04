// Authorized by HUB-1691 (E-FE-13 S6) — override action: trigger opens
// modal, reason ≥20 chars gate + live count, confirm POSTs to /:id/override,
// 409 already-overridden distinct copy, 422 short-reason distinct copy,
// success → onOverrideSuccess.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { FailedPaymentsOverrideAction } from '../FailedPaymentsOverrideAction';
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

async function openModalAndType(reason: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('failed-payments-override-trigger'));
  });
  await waitFor(() => {
    expect(
      screen.getByTestId('failed-payments-override-modal'),
    ).toBeInTheDocument();
  });
  await act(async () => {
    fireEvent.change(screen.getByTestId('failed-payments-override-reason'), {
      target: { value: reason },
    });
  });
}

describe('FailedPaymentsOverrideAction (HUB-1691)', () => {
  it('trigger opens the modal + confirm is disabled until ≥20 chars', async () => {
    render(
      <FailedPaymentsOverrideAction
        invoiceRowId={INVOICE_ID}
        onOverrideSuccess={vi.fn()}
      />,
    );
    await openModalAndType('too short');
    const confirmBtn = screen.getByTestId(
      'failed-payments-override-confirm',
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(
      screen.getByTestId('failed-payments-override-reason-count').textContent,
    ).toContain('9 / 20');
  });

  it('reason ≥20 chars enables confirm; live count switches to seafoam class', async () => {
    render(
      <FailedPaymentsOverrideAction
        invoiceRowId={INVOICE_ID}
        onOverrideSuccess={vi.fn()}
      />,
    );
    await openModalAndType('Customer contacted, will pay next cycle');
    const confirmBtn = screen.getByTestId(
      'failed-payments-override-confirm',
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    const count = screen.getByTestId(
      'failed-payments-override-reason-count',
    );
    expect(count.className).toContain('seafoam');
  });

  it('confirm success → POSTs reason + fires onOverrideSuccess + closes modal', async () => {
    apiPostMock.mockResolvedValue({
      overriddenAt: '2026-07-03T00:00:00.000Z',
      overriddenBy: 'op-1',
    });
    const onOverrideSuccess = vi.fn();
    render(
      <FailedPaymentsOverrideAction
        invoiceRowId={INVOICE_ID}
        onOverrideSuccess={onOverrideSuccess}
      />,
    );
    await openModalAndType('Customer contacted, will pay next cycle');
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-override-confirm'));
    });
    await waitFor(() => {
      expect(onOverrideSuccess).toHaveBeenCalledOnce();
    });
    expect(apiPostMock).toHaveBeenCalledOnce();
    expect(apiPostMock.mock.calls[0]![0]).toBe(
      `/api/v1/admin/billing/failed-payments/${INVOICE_ID}/override`,
    );
    expect(apiPostMock.mock.calls[0]![1]).toEqual({
      reason: 'Customer contacted, will pay next cycle',
    });
    // Modal closes on success.
    expect(
      screen.queryByTestId('failed-payments-override-modal'),
    ).toBeNull();
  });

  it('409 already-overridden → distinct error copy', async () => {
    apiPostMock.mockRejectedValue(new ApiError(409, 'already_overridden'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <FailedPaymentsOverrideAction
        invoiceRowId={INVOICE_ID}
        onOverrideSuccess={vi.fn()}
      />,
    );
    await openModalAndType('Customer contacted, will pay next cycle');
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-override-confirm'));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-override-error'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-override-error').textContent,
    ).toContain('already been overridden');
    errSpy.mockRestore();
  });

  it('422 short reason (server-side) → dedicated error copy', async () => {
    apiPostMock.mockRejectedValue(new ApiError(422, 'reason_too_short'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <FailedPaymentsOverrideAction
        invoiceRowId={INVOICE_ID}
        onOverrideSuccess={vi.fn()}
      />,
    );
    await openModalAndType('Customer contacted, will pay next cycle');
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-override-confirm'));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('failed-payments-override-error'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('failed-payments-override-error').textContent,
    ).toContain('at least 20 characters');
    errSpy.mockRestore();
  });

  it('cancel closes the modal without calling the endpoint', async () => {
    render(
      <FailedPaymentsOverrideAction
        invoiceRowId={INVOICE_ID}
        onOverrideSuccess={vi.fn()}
      />,
    );
    await openModalAndType('Customer contacted, will pay next cycle');
    await act(async () => {
      fireEvent.click(screen.getByTestId('failed-payments-override-cancel'));
    });
    expect(
      screen.queryByTestId('failed-payments-override-modal'),
    ).toBeNull();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
