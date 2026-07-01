// Authorized by HUB-1650 (E-FE-2 S7) — Per-widget error boundary. Wraps
// each dashboard widget so that a runtime throw in one widget cannot blank
// the entire dashboard (FR-014 widget isolation). The failure surfaces as
// a per-widget error panel with a retry button; sibling widgets continue
// rendering their own state.
//
// This complements each widget's built-in fetch-error handling: fetch
// failures are handled inline by the widget's state machine (e.g., the
// PortfolioSummaryWidget's 'error' branch); THIS boundary is the last-
// resort catch for runtime exceptions (e.g., a null-deref in a render
// path) that the state machine can't anticipate.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface WidgetErrorBoundaryProps {
  widgetLabel: string;
  children: ReactNode;
}

interface WidgetErrorBoundaryState {
  errored: boolean;
  message: string | null;
}

export class WidgetErrorBoundary extends Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  constructor(props: WidgetErrorBoundaryProps) {
    super(props);
    this.state = { errored: false, message: null };
  }

  static getDerivedStateFromError(err: unknown): WidgetErrorBoundaryState {
    const message =
      err instanceof Error ? err.message : 'Unexpected widget failure';
    return { errored: true, message };
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    // Best-effort telemetry — the observability plumbing lives outside this
    // widget; console.error is the fallback per the frontend's existing
    // logging pattern (Sentry / equivalent will be wired later).
    console.error(
      `WidgetErrorBoundary caught error in "${this.props.widgetLabel}"`,
      err,
      info,
    );
  }

  private handleRetry = (): void => {
    // React will re-render the children subtree; if the throw was
    // transient (network, race), the retry will succeed.
    this.setState({ errored: false, message: null });
  };

  override render(): ReactNode {
    if (this.state.errored) {
      return (
        <div
          role="alert"
          data-testid={`widget-error-boundary-${this.props.widgetLabel}`}
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
        >
          <p className="font-medium">
            {this.props.widgetLabel} failed to render.
          </p>
          {this.state.message && <p className="mt-1">{this.state.message}</p>}
          <button
            type="button"
            data-testid={`widget-error-boundary-retry-${this.props.widgetLabel}`}
            onClick={this.handleRetry}
            className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
