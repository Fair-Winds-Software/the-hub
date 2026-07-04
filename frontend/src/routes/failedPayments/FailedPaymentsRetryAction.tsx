// Authorized by HUB-1690 (E-FE-13 S5) — "Retry now" action. Uses the
// canonical HUB-1575 ConfirmDestructive two-step confirm (LK-144 Alert
// Dialog isn't in HUB deps at v0.1 — same substitution pattern used
// elsewhere in this Epic).
//
// The 30-second in-flight guard is enforced BY THE BE (HUB-1686) — a
// second retry within 30s returns 409 { retry_in_flight, nextRetryAt }.
// This UI treats that response distinctly from a generic error so the
// operator gets targeted messaging + a next-retry timestamp.
import { useState } from 'react';
import { apiClient } from '../../lib/api';
import { ApiError } from '../../lib/errors';
import { ConfirmDestructive } from '../../components/ConfirmDestructive';
import { formatMultiCurrencyCents } from './failed-payments-formatters';

const RETRY_PATH = '/api/v1/admin/billing/failed-payments';

interface FailedPaymentsRetryActionProps {
  invoiceRowId: string;
  amountCents: number;
  currency: string;
  onRetrySuccess: () => void;
}

export function FailedPaymentsRetryAction({
  invoiceRowId,
  amountCents,
  currency,
  onRetrySuccess,
}: FailedPaymentsRetryActionProps): React.ReactElement {
  const [inFlightError, setInFlightError] = useState<string | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);

  const handleConfirm = async (): Promise<void> => {
    setInFlightError(null);
    setGenericError(null);
    try {
      await apiClient.post(`${RETRY_PATH}/${invoiceRowId}/retry`);
      onRetrySuccess();
    } catch (err: unknown) {
      // BE returns HTTP 409 { retry_in_flight } — surface with the
      // targeted "already pending" wording. Any other error is generic.
      if (err instanceof ApiError && err.status === 409) {
        setInFlightError(
          'A retry is already pending for this invoice. Please wait ~30 seconds and try again.',
        );
        // Throw so ConfirmDestructive keeps the dialog open + surfaces
        // the error (its own retry / cancel affordances still work).
        throw new Error('retry_in_flight');
      }
      const message =
        err instanceof Error ? err.message : 'Retry failed';
      setGenericError(message);
      throw err;
    }
  };

  const bodyCopy = `Trigger a Stripe retry for ${formatMultiCurrencyCents(amountCents, currency)}? This charges the customer's card again. If the last retry fired within 30 seconds, Stripe will NOT be called (no double-charge — enforced server-side).`;

  return (
    <div className="flex flex-col gap-2">
      {(inFlightError ?? genericError) && (
        <p
          role="alert"
          data-testid="failed-payments-retry-error"
          className="rounded-md border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
        >
          {inFlightError ?? genericError}
        </p>
      )}
      <ConfirmDestructive
        title="Retry payment"
        body={bodyCopy}
        confirmLabel="Retry now"
        onConfirm={handleConfirm}
        trigger={(open) => (
          <button
            type="button"
            data-testid="failed-payments-retry-trigger"
            onClick={() => {
              setInFlightError(null);
              setGenericError(null);
              open();
            }}
            className="rounded border border-primary-navy/40 bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Retry now
          </button>
        )}
      />
    </div>
  );
}
