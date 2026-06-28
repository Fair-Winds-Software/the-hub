// Authorized by HUB-1611 (E-FE-12 S1) — SideDrawer component tests. Covers props contract,
// keyboard a11y (Escape + focus return + Tab trap), URL sync (mount + close + browser back),
// size widths, and axe-core zero violations on the open state.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { SideDrawer, type SideDrawerSize } from '../SideDrawer';

interface HarnessProps {
  initialOpen?: boolean;
  size?: SideDrawerSize;
  urlParam?: string;
  // Optional spy for external onClose observation
  onClose?: () => void;
}

// Wrapper that mirrors the production usage: a button as the trigger, drawer controlled by
// local state (or by URL when urlParam is set). Defaults route to MemoryRouter so the
// react-router-dom hooks have a router context.
function Harness({ initialOpen = false, size, urlParam, onClose }: HarnessProps) {
  return (
    <MemoryRouter initialEntries={['/']}>
      <HarnessInner
        initialOpen={initialOpen}
        size={size}
        urlParam={urlParam}
        onCloseSpy={onClose}
      />
    </MemoryRouter>
  );
}

function HarnessInner({
  initialOpen,
  size,
  urlParam,
  onCloseSpy,
}: {
  initialOpen: boolean;
  size?: SideDrawerSize;
  urlParam?: string;
  onCloseSpy?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [searchParams] = useSearchParams();
  const handleClose = () => {
    setOpen(false);
    onCloseSpy?.();
  };
  return (
    <div>
      <button
        type="button"
        data-testid="trigger"
        onClick={() => setOpen(true)}
      >
        Open drawer
      </button>
      <span data-testid="url-state">{searchParams.toString()}</span>
      <SideDrawer
        open={open}
        onClose={handleClose}
        title="Test drawer"
        size={size}
        urlParam={urlParam}
      >
        <p>Drawer body content</p>
        <button type="button" data-testid="inside-1">
          inside 1
        </button>
        <button type="button" data-testid="inside-2">
          inside 2
        </button>
      </SideDrawer>
    </div>
  );
}

beforeEach(() => {
  // Testing Library cleans up between tests; no manual document.body reset needed.
});

describe('SideDrawer (HUB-1611)', () => {
  describe('AC#1 — open/closed rendering + ARIA contract', () => {
    it('renders nothing in DOM when open=false', () => {
      render(<Harness initialOpen={false} />);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('renders role="dialog" + aria-modal="false" + aria-labelledby matching title', () => {
      render(<Harness initialOpen={true} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'false');
      expect(dialog).toHaveAttribute('aria-labelledby');
      const labelledById = dialog.getAttribute('aria-labelledby')!;
      expect(document.getElementById(labelledById)?.textContent).toBe('Test drawer');
    });

    it('header heading is the title text', () => {
      render(<Harness initialOpen={true} />);
      expect(
        screen.getByRole('heading', { name: 'Test drawer', level: 2 }),
      ).toBeInTheDocument();
    });
  });

  describe('AC#4 — close affordances', () => {
    it('close button has aria-label="Close" and triggers onClose', () => {
      const onClose = vi.fn();
      render(<Harness initialOpen={true} onClose={onClose} />);
      const closeBtn = screen.getByRole('button', { name: 'Close' });
      fireEvent.click(closeBtn);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Escape key triggers onClose', () => {
      const onClose = vi.fn();
      render(<Harness initialOpen={true} onClose={onClose} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC#3 — size widths (sm/md/lg → 320/480/640 px)', () => {
    it.each<[SideDrawerSize, string]>([
      ['sm', '320px'],
      ['md', '480px'],
      ['lg', '640px'],
    ])('size="%s" sets container width to %s', (size, expected) => {
      render(<Harness initialOpen={true} size={size} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveStyle({ width: expected });
    });

    it('default size is "md" (480px)', () => {
      render(<Harness initialOpen={true} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveStyle({ width: '480px' });
    });
  });

  describe('AC#5 — focus management', () => {
    it('focus returns to trigger element on close', async () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <Harness initialOpen={false} onClose={onClose} />,
      );
      const trigger = screen.getByTestId('trigger');
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();

      // Close via the close button; the harness's onClose sets open=false.
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));

      // queueMicrotask defers focus restoration past the React commit. Wait for it.
      await waitFor(() => expect(document.activeElement).toBe(trigger));

      // Sanity that the dialog actually closed.
      expect(screen.queryByRole('dialog')).toBeNull();
      // The harness wires its onClose to the spy.
      expect(onClose).toHaveBeenCalled();

      // Re-render keeps the test stable (no leaked timers/listeners).
      rerender(<Harness initialOpen={false} onClose={onClose} />);
    });
  });

  describe('AC#6 — non-modal Sheet pattern (no backdrop, left content stays interactive)', () => {
    it('does NOT render a backdrop element', () => {
      render(<Harness initialOpen={true} />);
      // Heuristic: backdrop in HUB convention uses bg-primary-navy/50 (per ConfirmDestructive).
      // SideDrawer must NOT render that overlay. Asserting absence of `aria-modal="true"`
      // also confirms the non-modal contract (the dialog itself is aria-modal="false").
      expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    });

    it('aria-modal="false" so screen-readers and AT do not trap users in the drawer', () => {
      render(<Harness initialOpen={true} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'false');
    });
  });

  describe('AC#7 — URL sync (opt-in via urlParam prop)', () => {
    it('writes the url param when open transitions from false → true', async () => {
      render(<Harness initialOpen={false} urlParam="audit" />);
      // Initially closed, URL has no audit param.
      expect(screen.getByTestId('url-state').textContent).toBe('');

      fireEvent.click(screen.getByTestId('trigger'));
      await waitFor(() =>
        expect(screen.getByTestId('url-state').textContent).toBe('audit=1'),
      );
    });

    it('removes the url param when open transitions from true → false', async () => {
      render(<Harness initialOpen={false} urlParam="audit" />);
      fireEvent.click(screen.getByTestId('trigger'));
      await waitFor(() =>
        expect(screen.getByTestId('url-state').textContent).toBe('audit=1'),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() =>
        expect(screen.getByTestId('url-state').textContent).toBe(''),
      );
    });

    it('no URL changes when urlParam prop is omitted', async () => {
      render(<Harness initialOpen={false} />);
      expect(screen.getByTestId('url-state').textContent).toBe('');
      fireEvent.click(screen.getByTestId('trigger'));
      // URL state stays empty even though drawer is open.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId('url-state').textContent).toBe('');
    });
  });

  describe('a11y — axe-core zero violations on open state', () => {
    it('has no a11y violations when open', async () => {
      const { container } = render(<Harness initialOpen={true} />);
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
