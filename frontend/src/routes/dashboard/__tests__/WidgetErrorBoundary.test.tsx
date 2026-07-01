// Authorized by HUB-1650 (E-FE-2 S7) — WidgetErrorBoundary tests. Covers
// happy-path pass-through, error catch + per-widget panel + retry, and
// widget-isolation invariant (sibling boundary keeps rendering when one
// boundary catches).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { useState } from 'react';
import { WidgetErrorBoundary } from '../WidgetErrorBoundary';

function AlwaysThrows(): React.ReactElement {
  throw new Error('boom-widget');
}

function TogglesToOk({ retryFlag }: { retryFlag: boolean }): React.ReactElement {
  if (!retryFlag) throw new Error('first-render-fails');
  return <div data-testid="toggle-ok">OK</div>;
}

afterEach(() => {
  cleanup();
});

describe('WidgetErrorBoundary (HUB-1650)', () => {
  it('passes children through when no error is thrown', () => {
    render(
      <WidgetErrorBoundary widgetLabel="pass-through">
        <span data-testid="pass-through-child">ok</span>
      </WidgetErrorBoundary>,
    );
    expect(screen.getByTestId('pass-through-child')).toBeInTheDocument();
    expect(
      screen.queryByTestId('widget-error-boundary-pass-through'),
    ).toBeNull();
  });

  it('catches a thrown error and renders a per-widget error panel with retry button', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <WidgetErrorBoundary widgetLabel="failing">
        <AlwaysThrows />
      </WidgetErrorBoundary>,
    );
    expect(
      screen.getByTestId('widget-error-boundary-failing'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('widget-error-boundary-failing').textContent,
    ).toMatch(/boom-widget/);
    expect(
      screen.getByTestId('widget-error-boundary-retry-failing'),
    ).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('widget isolation — one boundary catching does NOT unmount a sibling boundary', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <>
        <WidgetErrorBoundary widgetLabel="failing-a">
          <AlwaysThrows />
        </WidgetErrorBoundary>
        <WidgetErrorBoundary widgetLabel="healthy-b">
          <span data-testid="healthy-child">still here</span>
        </WidgetErrorBoundary>
      </>,
    );
    expect(
      screen.getByTestId('widget-error-boundary-failing-a'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('healthy-child')).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('retry clears the boundary state so a subsequent successful render is displayed', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Harness(): React.ReactElement {
      const [flag, setFlag] = useState(false);
      return (
        <>
          <WidgetErrorBoundary widgetLabel="retryable">
            <TogglesToOk retryFlag={flag} />
          </WidgetErrorBoundary>
          <button
            type="button"
            data-testid="flip"
            onClick={() => setFlag(true)}
          >
            flip
          </button>
        </>
      );
    }
    render(<Harness />);
    expect(
      screen.getByTestId('widget-error-boundary-retryable'),
    ).toBeInTheDocument();
    // Flip the "next render succeeds" flag, then hit retry.
    fireEvent.click(screen.getByTestId('flip'));
    fireEvent.click(
      screen.getByTestId('widget-error-boundary-retry-retryable'),
    );
    expect(screen.getByTestId('toggle-ok')).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
