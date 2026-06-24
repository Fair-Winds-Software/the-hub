// Authorized by HUB-1577 — error boundary for the Console Shell main slot (AC#6).
// Renders a "Something went wrong" fallback in the main slot while keeping the
// surrounding TopNav + Sidebar functional so the operator can navigate away.
// v0.1: log to console only (no production telemetry surface per FR).
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ConsoleShellErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // v0.1: operator console internal — log to console only.
    console.error('ConsoleShell caught error:', error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="rounded-md border border-ironwake/30 bg-ironwake/10 p-6"
        >
          <h2 className="font-heading text-xl text-primary-navy mb-2">
            Something went wrong
          </h2>
          <p className="font-body text-deep-charcoal mb-3">
            The current view encountered an error. You can navigate to another section
            using the sidebar, or refresh the page to try again.
          </p>
          <pre className="font-mono text-xs text-deep-charcoal bg-sailcloth p-3 rounded overflow-auto max-h-32">
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
