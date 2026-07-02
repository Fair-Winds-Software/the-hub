// Authorized by HUB-1679 (E-FE-7 S6) — per-tab error boundary. Wraps
// each drill-in tab so a runtime throw or 5xx-shaped fetch never blanks
// the parent detail shell. FR-018 widget-isolation contract: one tab's
// failure does NOT cascade to sibling tabs — each tab that a subsequent
// navigation mounts still runs its own load.
//
// This complements each tab's inline fetch-error state (the 'Retry'
// panel from S4/S5). The boundary is the last-resort catch for
// exceptions the state machine can't anticipate.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface HealthTabErrorBoundaryProps {
  tabLabel: string;
  children: ReactNode;
}

interface HealthTabErrorBoundaryState {
  errored: boolean;
  message: string | null;
}

export class HealthTabErrorBoundary extends Component<
  HealthTabErrorBoundaryProps,
  HealthTabErrorBoundaryState
> {
  constructor(props: HealthTabErrorBoundaryProps) {
    super(props);
    this.state = { errored: false, message: null };
  }

  static getDerivedStateFromError(err: unknown): HealthTabErrorBoundaryState {
    const message =
      err instanceof Error ? err.message : 'Health endpoint unavailable';
    return { errored: true, message };
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    console.error(
      `HealthTabErrorBoundary caught error in "${this.props.tabLabel}" tab`,
      err,
      info,
    );
  }

  private handleRetry = (): void => {
    this.setState({ errored: false, message: null });
  };

  override render(): ReactNode {
    if (this.state.errored) {
      return (
        <div
          role="alert"
          data-testid={`health-tab-error-boundary-${this.props.tabLabel}`}
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
        >
          <p className="font-medium">
            Health endpoint unavailable for {this.props.tabLabel}.
          </p>
          {this.state.message && <p className="mt-1">{this.state.message}</p>}
          <button
            type="button"
            data-testid={`health-tab-error-boundary-retry-${this.props.tabLabel}`}
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
