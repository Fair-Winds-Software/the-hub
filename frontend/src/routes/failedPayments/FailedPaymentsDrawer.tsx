// Authorized by HUB-1689 (E-FE-13 S4) — Failed Payment drawer content:
// Stripe error detail, retry history, customer email, "View in Stripe"
// deep-link. Consumes HUB-1611 SideDrawer as the outer container per
// its "downstream Epics MUST consume this component" contract.
//
// Retry (S5) + Override (S6) action buttons land in the drawer footer
// in the subsequent stories.
//
// Spec deviation (per ironclad-engineer): story spec referenced LK-145
// Sheet for the drawer. HUB-1611 already provides the canonical Sheet
// pattern (SideDrawer); LK-145 isn't in the HUB frontend deps. Same
// deviation pattern as HUB-1567 chart / HUB-1568 confirmation dialog.

import { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api';
import { SideDrawer } from '../../components/SideDrawer';
import {
  formatDateTime,
  formatMultiCurrencyCents,
  formatRelativeTime,
  statusLabel,
} from './failed-payments-formatters';
import type { FailedPaymentStatus } from '../FailedPayments';
import { FailedPaymentsRetryAction } from './FailedPaymentsRetryAction';

const DRILL_IN_PATH = '/api/v1/admin/billing/failed-payments';

export interface FailedPaymentDetail {
  id: string;
  invoiceId: string;
  stripeSubscriptionId: string | null;
  tenantId: string;
  tenantName: string;
  productId: string;
  amountCents: number;
  currency: string;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastRetryTriggeredAt: string | null;
  status: FailedPaymentStatus;
  overriddenAt: string | null;
  overriddenBy: string | null;
  overrideReason: string | null;
  retryHistory: Array<{
    attemptAt: string;
    declineCode: string | null;
    errorMessage: string | null;
  }>;
}

type DetailState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; payload: FailedPaymentDetail };

interface FailedPaymentsDrawerProps {
  invoiceRowId: string | null;
  onClose: () => void;
  /**
   * HUB-1690 (S5) — fires after a successful retry so the parent list
   * refetches. Optional so S4 stayed valid without an action wired.
   */
  onActionComplete?: () => void;
}

function stripeDashboardUrl(subscriptionId: string): string {
  return `https://dashboard.stripe.com/subscriptions/${subscriptionId}`;
}

export function FailedPaymentsDrawer({
  invoiceRowId,
  onClose,
  onActionComplete,
}: FailedPaymentsDrawerProps): React.ReactElement {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });

  const handleActionSuccess = (): void => {
    onActionComplete?.();
    onClose();
  };

  // Retry is available only when the row is in a state that can be retried.
  const canRetry =
    state.kind === 'ready' &&
    (state.payload.status === 'pending_retry' ||
      state.payload.status === 'exhausted');

  useEffect(() => {
    if (!invoiceRowId) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    apiClient
      .get<FailedPaymentDetail>(`${DRILL_IN_PATH}/${invoiceRowId}`)
      .then((payload) => {
        if (!cancelled) setState({ kind: 'ready', payload });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load detail';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [invoiceRowId]);

  const title =
    state.kind === 'ready'
      ? `${state.payload.tenantName} · ${state.payload.invoiceId}`
      : 'Failed payment';

  return (
    <SideDrawer
      open={invoiceRowId !== null}
      onClose={onClose}
      title={title}
      size="md"
    >
      {state.kind === 'loading' && (
        <div
          data-testid="failed-payments-drawer-loading"
          className="h-40 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      )}
      {state.kind === 'error' && (
        <div
          role="alert"
          data-testid="failed-payments-drawer-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
        >
          <p className="font-medium">Couldn’t load detail.</p>
          <p className="mt-1">{state.message}</p>
        </div>
      )}
      {state.kind === 'ready' && (
        <div className="flex flex-col gap-4">
          <section
            data-testid="failed-payments-drawer-summary"
            className="flex flex-col gap-1 text-sm font-body"
          >
            <p className="text-deep-charcoal/70">
              Status:{' '}
              <span className="font-medium text-deep-charcoal">
                {statusLabel(state.payload.status)}
              </span>
            </p>
            <p className="text-deep-charcoal/70">
              Amount:{' '}
              <span className="font-mono text-deep-charcoal">
                {formatMultiCurrencyCents(
                  state.payload.amountCents,
                  state.payload.currency,
                )}
              </span>
            </p>
            <p className="text-deep-charcoal/70">
              Attempts:{' '}
              <span className="font-mono text-deep-charcoal">
                {state.payload.attemptCount} of {state.payload.maxAttempts}
              </span>
            </p>
            {state.payload.lastRetryTriggeredAt && (
              <p className="text-deep-charcoal/70">
                Last retry: {formatRelativeTime(state.payload.lastRetryTriggeredAt)}
              </p>
            )}
            {state.payload.overriddenAt && (
              <div
                data-testid="failed-payments-drawer-override"
                className="mt-1 rounded border border-deep-charcoal/15 bg-deep-charcoal/5 p-2 text-xs font-body text-deep-charcoal/70"
              >
                <p>
                  Overridden {formatDateTime(state.payload.overriddenAt)} by{' '}
                  <code className="font-mono">
                    {state.payload.overriddenBy}
                  </code>
                </p>
                <p className="mt-1">
                  Reason: {state.payload.overrideReason}
                </p>
              </div>
            )}
          </section>

          <section
            data-testid="failed-payments-drawer-history"
            className="flex flex-col gap-2"
          >
            <h3 className="text-xs font-body uppercase tracking-wide text-deep-charcoal/60">
              Retry history
            </h3>
            {(state.payload.retryHistory ?? []).length === 0 ? (
              <p className="text-xs font-body text-deep-charcoal/60">
                No previous retry events recorded.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {(state.payload.retryHistory ?? []).map((h, idx) => (
                  <li
                    key={`${h.attemptAt}-${idx}`}
                    data-testid={`failed-payments-drawer-history-${idx}`}
                    className="rounded border border-deep-charcoal/10 bg-white p-2 text-xs font-body"
                  >
                    <p className="font-mono text-deep-charcoal">
                      {formatDateTime(h.attemptAt)}
                    </p>
                    {h.declineCode && (
                      <p className="mt-1 text-deep-charcoal/70">
                        Decline code:{' '}
                        <code className="font-mono">{h.declineCode}</code>
                      </p>
                    )}
                    {h.errorMessage && (
                      <p className="mt-1 text-deep-charcoal/70">
                        {h.errorMessage}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div
            data-testid="failed-payments-drawer-actions"
            className="flex flex-col gap-2 border-t border-deep-charcoal/10 pt-3"
          >
            {canRetry && (
              <FailedPaymentsRetryAction
                invoiceRowId={state.payload.id}
                amountCents={state.payload.amountCents}
                currency={state.payload.currency}
                onRetrySuccess={handleActionSuccess}
              />
            )}
            {state.payload.stripeSubscriptionId && (
              <a
                data-testid="failed-payments-drawer-stripe-link"
                href={stripeDashboardUrl(state.payload.stripeSubscriptionId)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded border border-deep-charcoal/20 bg-transparent px-3 py-1.5 text-sm font-body text-deep-charcoal no-underline hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                View in Stripe →
              </a>
            )}
          </div>
        </div>
      )}
    </SideDrawer>
  );
}
