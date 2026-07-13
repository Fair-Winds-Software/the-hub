// Authorized by HUB-1801 (S5 of HUB-1784) — tests for the DeleteAllControls slot.
// Covers: button click opens confirm modal · phrase-typing gate ("DELETE") · cancel
// closes without firing DELETE · confirm fires DELETE + toast + refresh · error
// surfaces in role=alert · button disabled when snapshot is empty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeleteAllControls } from '../DeleteAllControls';
import { useToastStore } from '../../../stores/toastStore';

const EMPTY_SNAPSHOT = {
  customers: 0,
  products: 0,
  prices: 0,
  coupons: 0,
  subscriptions: 0,
  invoices: 0,
  discounts: 0,
  balance_transactions: 0,
};
const POPULATED_SNAPSHOT = { ...EMPTY_SNAPSHOT, customers: 3, subscriptions: 3 };

beforeEach(() => {
  useToastStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
});

function makeProps(overrides: Partial<React.ComponentProps<typeof DeleteAllControls>> = {}) {
  return {
    snapshot: POPULATED_SNAPSHOT,
    refresh: vi.fn(),
    onDelete: vi.fn().mockResolvedValue({ rows_deleted: 6 }),
    ...overrides,
  };
}

async function typeConfirmPhrase(): Promise<void> {
  const phraseInput = await screen.findByRole('textbox');
  fireEvent.change(phraseInput, { target: { value: 'DELETE' } });
}

describe('DeleteAllControls — disabled state', () => {
  it('button is disabled when snapshot is empty', () => {
    const props = makeProps({ snapshot: EMPTY_SNAPSHOT });
    render(<DeleteAllControls {...props} />);
    const btn = screen.getByTestId('delete-all-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('button is enabled when snapshot has rows', () => {
    const props = makeProps({ snapshot: POPULATED_SNAPSHOT });
    render(<DeleteAllControls {...props} />);
    const btn = screen.getByTestId('delete-all-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

describe('DeleteAllControls — confirm flow', () => {
  it('click opens the confirm dialog and shows the pre-delete row summary', async () => {
    const props = makeProps();
    render(<DeleteAllControls {...props} />);
    fireEvent.click(screen.getByTestId('delete-all-button'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('3 customers');
    expect(dialog.textContent).toContain('3 subscriptions');
  });

  it('cancel closes without firing DELETE', async () => {
    const props = makeProps();
    render(<DeleteAllControls {...props} />);
    fireEvent.click(screen.getByTestId('delete-all-button'));
    await screen.findByRole('alertdialog');
    const cancel = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancel);
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.refresh).not.toHaveBeenCalled();
  });

  it('confirm requires typing the phrase DELETE; then fires DELETE + toast + refresh', async () => {
    const props = makeProps();
    render(<DeleteAllControls {...props} />);
    fireEvent.click(screen.getByTestId('delete-all-button'));
    await screen.findByRole('alertdialog');
    const confirm = screen.getByRole('button', { name: /yes, delete everything/i });
    // Before typing, confirm is disabled.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await typeConfirmPhrase();
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => {
      expect(props.onDelete).toHaveBeenCalledOnce();
    });
    expect(props.refresh).toHaveBeenCalledOnce();
    // Toast fired with a friendly message.
    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBe(1);
    expect(toasts[0]!.variant).toBe('success');
    expect(toasts[0]!.message).toContain('Deleted 6 mock rows');
  });

  it('failure path surfaces the error in role=alert and skips refresh', async () => {
    const props = makeProps({
      onDelete: vi.fn().mockRejectedValue(new Error('LIVE mode — refused')),
    });
    render(<DeleteAllControls {...props} />);
    fireEvent.click(screen.getByTestId('delete-all-button'));
    await screen.findByRole('alertdialog');
    await typeConfirmPhrase();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /yes, delete everything/i }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('delete-error').textContent).toContain('LIVE mode — refused');
    });
    expect(props.refresh).not.toHaveBeenCalled();
  });
});
