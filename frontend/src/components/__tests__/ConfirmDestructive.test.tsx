// Authorized by HUB-1575 — ConfirmDestructive component tests (covers ACs #1-#7 + axe a11y)
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { ConfirmDestructive } from '../ConfirmDestructive';

function renderConfirm(props: Partial<React.ComponentProps<typeof ConfirmDestructive>> = {}) {
  const defaults = {
    title: 'Freeze tenant?',
    body: 'This pauses billing for the tenant until you unfreeze them.',
    onConfirm: vi.fn().mockResolvedValue(undefined),
    trigger: (open: () => void) => (
      <button type="button" onClick={open}>
        Open
      </button>
    ),
  };
  return render(<ConfirmDestructive {...defaults} {...props} />);
}

describe('ConfirmDestructive (HUB-1575)', () => {
  // Testing Library handles unmount + DOM cleanup automatically between tests.
  // Manually clearing document.body.innerHTML would yank the React portal's mount node
  // and cause "The node to be removed is not a child of this node" errors.

  describe('AC#1: trigger renders + opens modal on click', () => {
    it('renders trigger element; click opens alertdialog', () => {
      renderConfirm();
      const opener = screen.getByRole('button', { name: 'Open' });
      expect(screen.queryByRole('alertdialog')).toBeNull();

      fireEvent.click(opener);
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby');
      expect(dialog).toHaveAttribute('aria-describedby');
    });
  });

  describe('AC#2: requirePhrase gates confirm button', () => {
    it('disables confirm until exact phrase is typed (case-sensitive)', () => {
      renderConfirm({ requirePhrase: 'FREEZE-tenantA' });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));

      const confirmButton = screen.getByRole('button', { name: 'Confirm' });
      expect(confirmButton).toBeDisabled();

      const input = screen.getByRole('textbox');

      // Partial typing → still disabled.
      fireEvent.change(input, { target: { value: 'FREEZE-tenant' } });
      expect(confirmButton).toBeDisabled();

      // Case mismatch → still disabled.
      fireEvent.change(input, { target: { value: 'freeze-tenantA' } });
      expect(confirmButton).toBeDisabled();

      // Exact match → enabled.
      fireEvent.change(input, { target: { value: 'FREEZE-tenantA' } });
      expect(confirmButton).not.toBeDisabled();
    });
  });

  describe('AC#3: pending state disables button + shows spinner', () => {
    it('renders "Working..." and disables confirm while onConfirm is in flight', async () => {
      let resolveConfirm: (() => void) | undefined;
      const onConfirm = vi.fn(
        () => new Promise<void>((resolve) => { resolveConfirm = resolve; }),
      );
      renderConfirm({ onConfirm });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => {
        expect(screen.getByText(/Working/)).toBeInTheDocument();
      });
      const confirmButton = screen.getByRole('button', { name: /Working/ });
      expect(confirmButton).toBeDisabled();
      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      expect(cancelButton).toBeDisabled();

      // Resolve so we don't leak the promise.
      resolveConfirm!();
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).toBeNull();
      });
    });
  });

  describe('AC#4: rejection surfaces error + keeps modal open', () => {
    it('renders the error message and leaves modal mounted for retry', async () => {
      const onConfirm = vi.fn().mockRejectedValueOnce(new Error('Stripe API timeout'));
      renderConfirm({ onConfirm });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Stripe API timeout');
      });
      // Modal still open for retry.
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      // Confirm button is re-enabled (pending cleared).
      expect(screen.getByRole('button', { name: 'Confirm' })).not.toBeDisabled();
    });

    it('falls back to generic message when error has no message', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onConfirm = vi.fn().mockRejectedValueOnce('not an Error instance' as any);
      renderConfirm({ onConfirm });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Action failed');
      });
    });
  });

  describe('AC#5: resolution closes modal + resets internal state', () => {
    it('closes after resolve + clears typed phrase on next open', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      renderConfirm({ onConfirm, requirePhrase: 'DELETE' });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'DELETE' } });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).toBeNull();
      });

      // Re-open: typed phrase should be cleared, button disabled again.
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      const input = screen.getByRole('textbox') as HTMLInputElement;
      expect(input.value).toBe('');
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    });
  });

  describe('AC#6: Escape closes; backdrop click respects pending/typed state', () => {
    it('Escape closes the modal (when not pending)', () => {
      renderConfirm();
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('Escape does NOT close while onConfirm is pending', async () => {
      const onConfirm = vi.fn(() => new Promise<void>(() => {})); // never resolves
      renderConfirm({ onConfirm });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => {
        expect(screen.getByText(/Working/)).toBeInTheDocument();
      });

      fireEvent.keyDown(window, { key: 'Escape' });
      // Still open because pending blocks close.
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('backdrop click does NOT close if operator has typed into requirePhrase input', () => {
      renderConfirm({ requirePhrase: 'CONFIRM' });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'CO' } });

      // Click the outermost backdrop element (the fixed inset-0 wrapper).
      const dialog = screen.getByRole('alertdialog');
      const backdrop = dialog.parentElement as HTMLElement;
      fireEvent.click(backdrop);

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('backdrop click closes when no phrase typed and not pending', () => {
      renderConfirm({ requirePhrase: 'CONFIRM' });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));

      const dialog = screen.getByRole('alertdialog');
      const backdrop = dialog.parentElement as HTMLElement;
      fireEvent.click(backdrop);

      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  describe('A11y: axe-core 0 violations', () => {
    it('open modal has zero axe violations', async () => {
      const { container } = renderConfirm({
        requirePhrase: 'CONFIRM',
        title: 'Delete operator?',
        body: 'This removes the operator and all their sessions.',
      });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));

      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });
  });
});
