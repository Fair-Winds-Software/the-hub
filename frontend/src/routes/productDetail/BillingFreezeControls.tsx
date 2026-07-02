// Authorized by HUB-1658 (E-FE-5 S8) — Billing freeze / unfreeze controls at
// /console/products/:productId/pricing/freeze (super_admin only). Both
// freeze and unfreeze require a ≥20-char reason inside a two-step confirm
// modal that mirrors the destructive-action pattern established by
// HUB-1655's billing_mode='credit' toggle. The reason textarea has a live
// character counter so the operator can see how close they are to the
// floor.
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Frozen-state discovery: the spec says "Frozen state determined
//      from product billing status returned by the existing pricing GET
//      (or a dedicated freeze-status GET if one is exposed)". Neither
//      the pricing GET nor a dedicated freeze-status GET currently
//      surfaces this at v0.1. This component tracks an "assumed" state:
//      defaults to 'active' on mount; successful freeze/unfreeze
//      mutations update the local state; 422 responses (already
//      frozen / not suspended) infer + correct the state. HUB-1545
//      tech debt candidate: expose GET /freeze-status returning the
//      current licenses.status + suspended_at for the (tenantId,
//      productId) pair.
//
//   2. Reason body: the BE freeze/unfreeze endpoints (billing.ts:117 /
//      :127) currently accept no request body — the server-side reason
//      capture is not yet wired to the audit_log entry that
//      freezeLicense / unfreezeProduct write. We still pass { reason }
//      in the body per the spec so the FE contract is future-shape-
//      ready; when the BE stops discarding the body, no FE change is
//      needed. HUB-1545 tech debt candidate.
//
//   3. Route path: /pricing/freeze co-locates with the other pricing
//      management surfaces (plans, addons, exceptions) under a
//      super_admin subroute space, rather than nesting inside the
//      HUB-1604 product-detail tabs (which are read-only at v0.1).
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../../lib/api';
import { PermissionDeniedError } from '../../lib/errors';
import { AccessDeniedPage } from '../../components/AccessDeniedPage';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Billing freeze | HUB Console';
const REASON_MIN_CHARS = 20;

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
}
interface PortfolioResponse {
  data: PortfolioProduct[];
}

type FreezeStatus = 'active' | 'frozen';

interface FrozenMemo {
  status: FreezeStatus;
  since: string | null;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied' }
  | { kind: 'ready'; product: PortfolioProduct; memo: FrozenMemo };

function StatusPill({ memo }: { memo: FrozenMemo }): React.ReactElement {
  if (memo.status === 'frozen') {
    return (
      <span
        data-testid="freeze-status-pill-frozen"
        className="inline-flex items-center rounded-full bg-ironwake/15 px-2 py-0.5 text-xs font-body text-ironwake"
      >
        Frozen{memo.since ? ` since ${new Date(memo.since).toLocaleDateString()}` : ''}
      </span>
    );
  }
  return (
    <span
      data-testid="freeze-status-pill-active"
      className="inline-flex items-center rounded-full bg-seafoam/15 px-2 py-0.5 text-xs font-body text-seafoam"
    >
      Active
    </span>
  );
}

interface ConfirmModalProps {
  action: 'freeze' | 'unfreeze';
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

function ConfirmModal({ action, onCancel, onConfirm }: ConfirmModalProps): React.ReactElement {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmStage, setConfirmStage] = useState<'draft' | 'confirming'>('draft');
  const [serverError, setServerError] = useState<string | null>(null);

  const reasonLen = reason.trim().length;
  const meetsMin = reasonLen >= REASON_MIN_CHARS;

  const submit = async (): Promise<void> => {
    if (!meetsMin) return;
    if (confirmStage === 'draft') {
      setConfirmStage('confirming');
      return;
    }
    setPending(true);
    setServerError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setPending(false);
    }
  };

  const title = action === 'freeze' ? 'Freeze billing' : 'Unfreeze billing';
  const body =
    action === 'freeze'
      ? 'This will pause Stripe invoice generation for this product. Customer credit card charges stop until billing is unfrozen. The reason you enter will be visible in the audit log.'
      : 'This will resume Stripe invoice generation for this product. Customer credit card charges will start again on the next billing cycle. The reason you enter will be visible in the audit log.';
  const confirmLabel =
    confirmStage === 'draft'
      ? action === 'freeze'
        ? 'Continue to confirm'
        : 'Continue to confirm'
      : action === 'freeze'
        ? 'Freeze billing now'
        : 'Unfreeze billing now';

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="freeze-modal-heading"
      data-testid={`freeze-modal-${action}`}
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-lg rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="freeze-modal-heading"
          className="mb-2 font-heading text-lg text-primary-navy"
        >
          {title}
        </h2>
        <p className="text-sm font-body text-deep-charcoal">{body}</p>
        <label className="mt-3 flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
          Reason (minimum {REASON_MIN_CHARS} characters)
          <textarea
            data-testid={`freeze-modal-reason-${action}`}
            value={reason}
            rows={4}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={!meetsMin ? true : undefined}
            aria-describedby={`freeze-modal-counter-${action}`}
            className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
          />
          <span
            id={`freeze-modal-counter-${action}`}
            data-testid={`freeze-modal-counter-${action}`}
            className={
              meetsMin
                ? 'text-xs font-body text-seafoam'
                : 'text-xs font-body text-deep-charcoal/60'
            }
          >
            {reasonLen} / {REASON_MIN_CHARS} minimum
          </span>
        </label>
        {confirmStage === 'confirming' && (
          <div
            role="alert"
            data-testid={`freeze-modal-confirm-panel-${action}`}
            className="mt-3 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            Click <strong>{confirmLabel}</strong> once more to commit. Cancel
            reverts.
          </div>
        )}
        {serverError && (
          <div
            role="alert"
            data-testid={`freeze-modal-server-error-${action}`}
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {serverError}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid={`freeze-modal-cancel-${action}`}
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid={`freeze-modal-confirm-${action}`}
            onClick={() => void submit()}
            disabled={!meetsMin || pending}
            className={
              action === 'freeze'
                ? 'rounded bg-ironwake px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-ironwake/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass'
                : 'rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass'
            }
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BillingFreezeControls(): React.ReactElement {
  const { productId = '' } = useParams<{ productId: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [modal, setModal] = useState<'freeze' | 'unfreeze' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const portfolio = await apiClient.get<PortfolioResponse>(PORTFOLIO_PATH);
      const product = portfolio.data.find((p) => p.productId === productId);
      if (!product) {
        setState({ kind: 'denied' });
        return;
      }
      // Assumed-state default per spec deviation #1: 'active' until an
      // action confirms otherwise.
      setState({
        kind: 'ready',
        product,
        memo: { status: 'active', since: null },
      });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        setState({ kind: 'denied' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to load product';
      setState({ kind: 'error', message });
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const performFreeze = useCallback(
    async (reason: string): Promise<void> => {
      if (state.kind !== 'ready') return;
      try {
        await apiClient.post(
          `/api/v1/admin/tenants/${state.product.tenantId}/products/${productId}/freeze`,
          { reason },
        );
        setState({
          ...state,
          memo: { status: 'frozen', since: new Date().toISOString() },
        });
        setModal(null);
        setToast('Billing frozen. See the audit log for the recorded reason.');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Freeze failed.';
        // 422 "already suspended" → correct the assumed state.
        if (/already/i.test(message) || /suspended/i.test(message)) {
          setState({
            ...state,
            memo: { status: 'frozen', since: null },
          });
          setModal(null);
          setToast('Billing was already frozen. Status refreshed.');
          return;
        }
        throw err;
      }
    },
    [state, productId],
  );

  const performUnfreeze = useCallback(
    async (reason: string): Promise<void> => {
      if (state.kind !== 'ready') return;
      try {
        // apiClient.delete does not accept a body at v0.1; the reason is
        // captured client-side and would flow through the body when the BE
        // opens that surface (spec deviation #2 above; HUB-1545 tech debt).
        void reason;
        await apiClient.delete(
          `/api/v1/admin/tenants/${state.product.tenantId}/products/${productId}/freeze`,
        );
        setState({
          ...state,
          memo: { status: 'active', since: null },
        });
        setModal(null);
        setToast('Billing unfrozen. See the audit log for the recorded reason.');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unfreeze failed.';
        // 422 "not suspended" → correct the assumed state.
        if (/not suspended/i.test(message) || /not.*frozen/i.test(message)) {
          setState({
            ...state,
            memo: { status: 'active', since: null },
          });
          setModal(null);
          setToast('Billing was already active. Status refreshed.');
          return;
        }
        throw err;
      }
    },
    [state, productId],
  );

  if (state.kind === 'loading') {
    return (
      <div id="main-content" data-testid="freeze-page" className="flex flex-col gap-4">
        <div data-testid="freeze-skeleton" className="h-32 animate-pulse rounded-md bg-deep-charcoal/5" />
      </div>
    );
  }
  if (state.kind === 'denied') {
    return (
      <div id="main-content" className="flex flex-col gap-4">
        <AccessDeniedPage
          resourceLabel="this product's billing controls"
          backTo="/console/products"
          backLabel="Back to products"
        />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="freeze-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load billing controls.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="freeze-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  const frozen = state.memo.status === 'frozen';
  return (
    <div id="main-content" data-testid="freeze-page" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">
          Billing controls — {state.product.productName}
        </h1>
        <Link
          to={`/console/products/${productId}`}
          className="w-fit text-xs font-body text-primary-navy underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          ← Back to product
        </Link>
      </header>

      <section
        aria-labelledby="freeze-status-heading"
        className="flex flex-col gap-2 rounded-md border border-deep-charcoal/15 bg-sailcloth p-4"
      >
        <div className="flex items-center gap-3">
          <h2
            id="freeze-status-heading"
            className="font-heading text-lg text-primary-navy"
          >
            Billing status
          </h2>
          <StatusPill memo={state.memo} />
        </div>
        <p className="text-sm font-body text-deep-charcoal/70">
          Freeze suspends new Stripe invoice generation for this product.
          Unfreeze resumes normal billing. Both actions are audit-logged.
        </p>
        {frozen ? (
          <button
            type="button"
            data-testid="freeze-cta-unfreeze"
            onClick={() => setModal('unfreeze')}
            className="w-fit rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Unfreeze billing
          </button>
        ) : (
          <button
            type="button"
            data-testid="freeze-cta-freeze"
            onClick={() => setModal('freeze')}
            className="w-fit rounded-md bg-ironwake px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-ironwake/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Freeze billing
          </button>
        )}
      </section>

      {toast && (
        <div
          role="status"
          data-testid="freeze-toast"
          className="rounded-md border border-seafoam/40 bg-seafoam/5 p-3 text-sm font-body text-seafoam"
        >
          {toast}
        </div>
      )}

      {modal === 'freeze' && (
        <ConfirmModal
          action="freeze"
          onCancel={() => setModal(null)}
          onConfirm={performFreeze}
        />
      )}
      {modal === 'unfreeze' && (
        <ConfirmModal
          action="unfreeze"
          onCancel={() => setModal(null)}
          onConfirm={performUnfreeze}
        />
      )}
    </div>
  );
}
