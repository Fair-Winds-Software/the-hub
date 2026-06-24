// Authorized by HUB-1578 — Toaster a11y + auto-dismiss + reduced-motion tests
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { Toaster } from '../Toaster';
import { useToastStore } from '../../stores/toastStore';

function mockMatchMedia(matches: boolean): void {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  window.matchMedia = vi.fn().mockImplementation((_query: string) => ({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_evt: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_evt: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

describe('Toaster (HUB-1578)', () => {
  beforeEach(() => {
    useToastStore.getState().clearAll();
    vi.useFakeTimers();
    mockMatchMedia(false);
  });

  afterEach(() => {
    // useRealTimers is safe to call regardless of current timer mode; pending
    // fake timers are discarded by the timer reset.
    vi.useRealTimers();
  });

  it('renders nothing when no toasts queued', () => {
    render(<Toaster />);
    expect(screen.queryByTestId('toaster-polite')).toBeNull();
    expect(screen.queryByTestId('toaster-assertive')).toBeNull();
  });

  it('AC: info → polite live region (role="status")', () => {
    render(<Toaster />);
    act(() => {
      useToastStore.getState().addToast({ variant: 'info', message: 'hello' });
    });
    expect(screen.getByTestId('toaster-polite')).toHaveAttribute('role', 'status');
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('AC: warning → assertive live region (role="alert")', () => {
    render(<Toaster />);
    act(() => {
      useToastStore.getState().addToast({ variant: 'warning', message: 'denied' });
    });
    expect(screen.getByTestId('toaster-assertive')).toHaveAttribute('role', 'alert');
    expect(screen.getByText('denied')).toBeInTheDocument();
  });

  it('AC: auto-dismiss after 5000ms by default (motion enabled)', () => {
    render(<Toaster />);
    act(() => {
      useToastStore.getState().addToast({ variant: 'info', message: 'auto' });
    });
    expect(screen.getByText('auto')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText('auto')).toBeNull();
  });

  it('AC: respects custom autoDismissMs', () => {
    render(<Toaster />);
    act(() => {
      useToastStore.getState().addToast({
        variant: 'info',
        message: 'fast',
        autoDismissMs: 1000,
      });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('fast')).toBeNull();
  });

  it('AC: prefers-reduced-motion: reduce DISABLES auto-dismiss (manual only)', () => {
    mockMatchMedia(true);
    render(<Toaster />);
    act(() => {
      useToastStore.getState().addToast({ variant: 'info', message: 'sticky' });
    });
    act(() => {
      vi.advanceTimersByTime(60_000); // 60s — way past any normal auto-dismiss
    });
    expect(screen.getByText('sticky')).toBeInTheDocument();
  });

  it('AC: dismiss button removes the toast', () => {
    render(<Toaster />);
    act(() => {
      useToastStore.getState().addToast({ variant: 'warning', message: 'clickable' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('clickable')).toBeNull();
  });

  describe('A11y: axe-core 0 violations', () => {
    it('renders with toasts of every variant with zero violations', async () => {
      // axe-core uses real timers internally; the fake timers from beforeEach would
      // freeze it and cause this test to time out.
      vi.useRealTimers();
      const { container } = render(<Toaster />);
      act(() => {
        useToastStore.getState().addToast({ variant: 'info', message: 'info toast' });
        useToastStore.getState().addToast({ variant: 'success', message: 'ok' });
        useToastStore.getState().addToast({ variant: 'warning', message: 'careful' });
        useToastStore.getState().addToast({ variant: 'error', message: 'broke' });
      });
      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });
  });
});
