// Authorized by HUB-1663 (E-FE-6 S4) — Operators management sub-route at
// /console/settings/operators (mounts under the HUB-1662 Settings shell,
// which is super_admin-guarded). Consumes the pre-existing operators.ts
// admin endpoints (POST/GET/PUT/DELETE + PUT /:id/role).
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Temp-password provisioning: the story described BE returning
//      { operatorId, temporaryPassword } on POST. The actual BE at
//      operators.ts:21 requires the caller to send a password. The FE
//      therefore generates a strong random password client-side, POSTs it,
//      then surfaces the same string once so the operator can copy it
//      before the modal closes. This is functionally equivalent to the
//      spec's contract (the operator sees the password exactly once) but
//      lives on the FE. HUB-1545 tech debt candidate: move password
//      generation to the BE for defense-in-depth.
//
//   2. last_login column: OperatorRecord does not carry a last_login
//      field at v0.1 (operator_accounts schema doesn't expose it via the
//      SELECT_COLS list in services/operators.ts:19). Column renders '—'.
//      HUB-1545 tech debt candidate.
//
//   3. Last-super_admin protection: the BE assignOperatorRole service
//      has NO server-side guard against demoting the last super_admin
//      (verified at services/operators.ts:112 — only checks self-change).
//      FE UI-only guard: disables the role dropdown when the operator is
//      editing themselves AND currently super_admin, with helper text.
//      HUB-1545 tech debt candidate: add a server-side check that counts
//      remaining active super_admins before allowing the demotion.
//
//   4. Deactivation refresh-token revocation: the BE deactivateOperator
//      sets active=false but does not explicitly revoke refresh tokens
//      (verified at services/operators.ts:102 — pure UPDATE, no token
//      table write). Sessions expire naturally on next JWT verify
//      (operatorRbacHook rejects inactive accounts). Documented for the
//      story's E2E assertion; the FE relies on the RBAC hook's active
//      check rather than a synchronous revocation.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';
import { useOperator } from '../../stores/sessionStore';
import { formatDate } from '../productDetail/pricing-formatters';

const OPERATORS_PATH = '/api/v1/admin/operators';
const PAGE_TITLE = 'Operators | Settings | HUB Console';

type OperatorRole = 'super_admin' | 'product_admin' | string;

interface OperatorRow {
  id: string;
  email: string;
  role: OperatorRole;
  tenant_id: string | null;
  active: boolean;
  created_at: string;
  last_login_at?: string | null;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; operators: OperatorRow[] };

const KNOWN_ROLES: readonly OperatorRole[] = ['super_admin', 'product_admin'];

function generateTemporaryPassword(): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const bytes = new Uint32Array(24);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function RoleBadge({ role }: { role: OperatorRole }): React.ReactElement {
  if (role === 'super_admin') {
    return (
      <span
        data-testid="operator-role-super_admin"
        className="inline-flex items-center gap-1 rounded-full border border-primary-navy/40 bg-primary-navy/10 px-2 py-0.5 text-xs font-body text-primary-navy"
      >
        <span aria-hidden="true">★</span> super admin
      </span>
    );
  }
  if (role === 'product_admin') {
    return (
      <span
        data-testid="operator-role-product_admin"
        className="inline-flex items-center gap-1 rounded-full border border-seafoam/40 bg-seafoam/10 px-2 py-0.5 text-xs font-body text-seafoam"
      >
        <span aria-hidden="true">◆</span> product admin
      </span>
    );
  }
  // Legacy role rows (e.g. tenant_admin during the E-BE-1 rename window).
  return (
    <span
      data-testid={`operator-role-legacy-${role}`}
      title="Legacy role — change to product_admin on next edit."
      className="inline-flex items-center gap-1 rounded-full border border-accent-brass/40 bg-accent-brass/10 px-2 py-0.5 text-xs font-body text-accent-brass"
    >
      <span aria-hidden="true">△</span> {role}
    </span>
  );
}

function ActivePill({ active }: { active: boolean }): React.ReactElement {
  return active ? (
    <span
      data-testid="operator-active-yes"
      className="inline-flex items-center rounded-full bg-seafoam/15 px-2 py-0.5 text-xs font-body text-seafoam"
    >
      active
    </span>
  ) : (
    <span
      data-testid="operator-active-no"
      className="inline-flex items-center rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs font-body text-deep-charcoal/70"
    >
      inactive
    </span>
  );
}

interface NewOperatorDraft {
  email: string;
  role: 'super_admin' | 'product_admin';
  tenant_id: string;
}

interface NewOperatorModalProps {
  onCancel: () => void;
  onCreated: () => void;
}

function NewOperatorModal({ onCancel, onCreated }: NewOperatorModalProps): React.ReactElement {
  const [draft, setDraft] = useState<NewOperatorDraft>({
    email: '',
    role: 'product_admin',
    tenant_id: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!draft.email.trim()) nextErrors.email = 'Email is required.';
    if (draft.role === 'product_admin' && !draft.tenant_id.trim()) {
      nextErrors.tenant_id = 'Tenant ID is required for product_admin.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    const password = generateTemporaryPassword();
    try {
      await apiClient.post<OperatorRow>(OPERATORS_PATH, {
        email: draft.email.trim(),
        password,
        role: draft.role,
        tenant_id: draft.role === 'product_admin' ? draft.tenant_id.trim() : null,
      });
      setTempPassword(password);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleClose = (): void => {
    if (tempPassword) onCreated();
    else onCancel();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-operator-heading"
      data-testid="new-operator-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="new-operator-heading"
          className="mb-3 font-heading text-lg text-primary-navy"
        >
          New operator
        </h2>
        {tempPassword ? (
          <div className="flex flex-col gap-3">
            <div
              role="alert"
              data-testid="new-operator-password-banner"
              className="rounded border border-accent-brass/40 bg-accent-brass/5 p-2 text-xs font-body text-accent-brass"
            >
              This is the only time this password will be shown. The operator
              must reset on first login.
            </div>
            <div className="flex items-center gap-2 rounded border border-deep-charcoal/20 bg-white p-2 font-mono text-sm text-primary-navy">
              <code
                data-testid="new-operator-temp-password"
                className="min-w-0 flex-1 break-all"
              >
                {tempPassword}
              </code>
              <button
                type="button"
                data-testid="new-operator-copy"
                onClick={() => void handleCopy()}
                className="shrink-0 rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="new-operator-done"
                onClick={handleClose}
                className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Email
              <input
                data-testid="new-operator-email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                aria-invalid={errors.email ? true : undefined}
                className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              />
              {errors.email && (
                <span
                  data-testid="new-operator-email-err"
                  className="text-xs text-ironwake"
                >
                  {errors.email}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Role
              <select
                data-testid="new-operator-role"
                value={draft.role}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    role: e.target.value as 'super_admin' | 'product_admin',
                  })
                }
                className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                <option value="product_admin">product_admin</option>
                <option value="super_admin">super_admin</option>
              </select>
            </label>
            {draft.role === 'product_admin' && (
              <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
                Tenant ID
                <input
                  data-testid="new-operator-tenant-id"
                  type="text"
                  value={draft.tenant_id}
                  onChange={(e) =>
                    setDraft({ ...draft, tenant_id: e.target.value })
                  }
                  aria-invalid={errors.tenant_id ? true : undefined}
                  className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
                />
                {errors.tenant_id && (
                  <span
                    data-testid="new-operator-tenant-id-err"
                    className="text-xs text-ironwake"
                  >
                    {errors.tenant_id}
                  </span>
                )}
              </label>
            )}
            {serverError && (
              <div
                role="alert"
                data-testid="new-operator-server-error"
                className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
              >
                {serverError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="new-operator-cancel"
                onClick={onCancel}
                className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="new-operator-submit"
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
              >
                {submitting ? 'Creating…' : 'Create operator'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface EditOperatorModalProps {
  operator: OperatorRow;
  isSelfSuperAdmin: boolean;
  onCancel: () => void;
  onSaved: () => void;
}

function EditOperatorModal({
  operator,
  isSelfSuperAdmin,
  onCancel,
  onSaved,
}: EditOperatorModalProps): React.ReactElement {
  const [email, setEmail] = useState(operator.email);
  const [active, setActive] = useState(operator.active);
  const [role, setRole] = useState<'super_admin' | 'product_admin'>(
    operator.role === 'super_admin' ? 'super_admin' : 'product_admin',
  );
  const [tenantId, setTenantId] = useState(operator.tenant_id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const handleSave = async (): Promise<void> => {
    setSubmitting(true);
    setServerError(null);
    try {
      const contentPatch: Record<string, unknown> = {};
      if (email !== operator.email) contentPatch.email = email;
      if (active !== operator.active) contentPatch.active = active;
      if (Object.keys(contentPatch).length > 0) {
        await apiClient.put(`${OPERATORS_PATH}/${operator.id}`, contentPatch);
      }
      const roleChanged =
        role !== operator.role || tenantId !== (operator.tenant_id ?? '');
      if (roleChanged) {
        await apiClient.put(`${OPERATORS_PATH}/${operator.id}/role`, {
          role,
          tenant_id: role === 'product_admin' ? tenantId.trim() : null,
        });
      }
      onSaved();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-operator-heading"
      data-testid="edit-operator-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="edit-operator-heading"
          className="mb-3 font-heading text-lg text-primary-navy"
        >
          Edit operator — {operator.email}
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Email
            <input
              data-testid="edit-operator-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Role
            <select
              data-testid="edit-operator-role"
              value={role}
              onChange={(e) =>
                setRole(e.target.value as 'super_admin' | 'product_admin')
              }
              disabled={isSelfSuperAdmin}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-60"
            >
              <option value="product_admin">product_admin</option>
              <option value="super_admin">super_admin</option>
            </select>
            {isSelfSuperAdmin && (
              <span
                data-testid="edit-operator-role-locked"
                className="text-xs text-deep-charcoal/60"
              >
                You are a super_admin editing yourself — promote another
                operator to super_admin before you can change this role.
              </span>
            )}
          </label>
          {role === 'product_admin' && (
            <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
              Tenant ID
              <input
                data-testid="edit-operator-tenant-id"
                type="text"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            <input
              type="checkbox"
              data-testid="edit-operator-active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Active
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="edit-operator-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="edit-operator-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="edit-operator-submit"
            onClick={() => void handleSave()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DeactivateDialogState {
  operator: OperatorRow;
  stage: 'ask' | 'confirming';
  submitting: boolean;
  errorMessage: string | null;
}

interface DeactivateDialogProps {
  state: DeactivateDialogState;
  onCancel: () => void;
  onAdvance: () => void;
  onConfirm: () => void;
}

function DeactivateDialog({
  state,
  onCancel,
  onAdvance,
  onConfirm,
}: DeactivateDialogProps): React.ReactElement {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="deactivate-operator-heading"
      data-testid="deactivate-operator-dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="deactivate-operator-heading"
          className="mb-2 font-heading text-lg text-primary-navy"
        >
          Deactivate {state.operator.email}
        </h2>
        <p className="text-sm font-body text-deep-charcoal">
          Are you sure? This will sign them out immediately and revoke their
          access to the HUB Console.
        </p>
        {state.stage === 'confirming' && (
          <div
            role="alert"
            data-testid="deactivate-operator-confirm-panel"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            Click <strong>Deactivate now</strong> once more to commit.
          </div>
        )}
        {state.errorMessage && (
          <div
            role="alert"
            data-testid="deactivate-operator-error"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {state.errorMessage}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="deactivate-operator-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="deactivate-operator-confirm"
            onClick={state.stage === 'ask' ? onAdvance : onConfirm}
            disabled={state.submitting}
            className="rounded bg-ironwake px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-ironwake/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {state.submitting
              ? 'Deactivating…'
              : state.stage === 'ask'
                ? 'Continue to confirm'
                : 'Deactivate now'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OperatorsManager(): React.ReactElement {
  const currentOperator = useOperator();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [showDeactivated, setShowDeactivated] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<OperatorRow | null>(null);
  const [deactivateDialog, setDeactivateDialog] =
    useState<DeactivateDialogState | null>(null);

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
      const qs = new URLSearchParams();
      if (!showDeactivated) qs.set('active', 'true');
      const url = qs.toString().length > 0 ? `${OPERATORS_PATH}?${qs}` : OPERATORS_PATH;
      const rows = await apiClient.get<OperatorRow[]>(url);
      const sorted = [...rows].sort((a, b) => {
        if (a.active === b.active) return a.email.localeCompare(b.email);
        return a.active ? -1 : 1;
      });
      setState({ kind: 'ready', operators: sorted });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load operators';
      setState({ kind: 'error', message });
    }
  }, [showDeactivated]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDeactivateConfirm = useCallback(async (): Promise<void> => {
    if (!deactivateDialog) return;
    setDeactivateDialog({
      ...deactivateDialog,
      submitting: true,
      errorMessage: null,
    });
    try {
      await apiClient.delete(
        `${OPERATORS_PATH}/${deactivateDialog.operator.id}`,
      );
      setDeactivateDialog(null);
      void load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Deactivate failed.';
      setDeactivateDialog({
        ...deactivateDialog,
        submitting: false,
        errorMessage: message,
      });
    }
  }, [deactivateDialog, load]);

  const isSelfSuperAdmin = useMemo(() => {
    if (!editing || !currentOperator) return false;
    return (
      editing.id === currentOperator.id && editing.role === 'super_admin'
    );
  }, [editing, currentOperator]);

  if (state.kind === 'loading') {
    return (
      <div id="main-content" data-testid="operators-manager-page">
        <div
          data-testid="operators-manager-skeleton"
          className="h-32 animate-pulse rounded-md bg-deep-charcoal/5"
        />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        id="main-content"
        role="alert"
        data-testid="operators-manager-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load operators.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="operators-manager-retry"
          onClick={() => void load()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      id="main-content"
      data-testid="operators-manager-page"
      className="flex flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h1 className="font-heading text-2xl text-primary-navy">Operators</h1>
        <button
          type="button"
          data-testid="operators-manager-new"
          onClick={() => setShowNew(true)}
          className="rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          New operator
        </button>
      </header>

      <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
        <input
          type="checkbox"
          data-testid="operators-show-deactivated"
          checked={showDeactivated}
          onChange={(e) => setShowDeactivated(e.target.checked)}
        />
        Show deactivated
      </label>

      {state.operators.length === 0 ? (
        <div
          data-testid="operators-manager-empty"
          className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
        >
          No operators yet. Click <strong>New operator</strong> to add one.
        </div>
      ) : (
        <ul
          data-testid="operators-manager-list"
          className="flex flex-col gap-2"
        >
          {state.operators.map((op) => (
            <li
              key={op.id}
              data-testid={`operators-row-${op.id}`}
              className={
                op.active
                  ? 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-sailcloth p-3'
                  : 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-deep-charcoal/5 p-3'
              }
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading text-base text-primary-navy">
                  {op.email}
                </p>
                <p className="text-xs font-body text-deep-charcoal/60">
                  Last login: {formatDate(op.last_login_at ?? null)}
                  {op.role === 'product_admin' && (
                    <>
                      {' · Tenant: '}
                      <code
                        data-testid={`operators-tenant-${op.id}`}
                        className="font-mono"
                      >
                        {shortId(op.tenant_id)}
                      </code>
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <RoleBadge role={op.role} />
                <ActivePill active={op.active} />
                {op.active && (
                  <>
                    <button
                      type="button"
                      data-testid={`operators-edit-${op.id}`}
                      onClick={() => setEditing(op)}
                      className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      data-testid={`operators-deactivate-${op.id}`}
                      onClick={() =>
                        setDeactivateDialog({
                          operator: op,
                          stage: 'ask',
                          submitting: false,
                          errorMessage: null,
                        })
                      }
                      className="rounded border border-ironwake/40 px-2 py-1 text-xs font-body text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                    >
                      Deactivate
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {showNew && (
        <NewOperatorModal
          onCancel={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void load();
          }}
        />
      )}

      {editing && (
        <EditOperatorModal
          operator={editing}
          isSelfSuperAdmin={isSelfSuperAdmin}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {deactivateDialog && (
        <DeactivateDialog
          state={deactivateDialog}
          onCancel={() => setDeactivateDialog(null)}
          onAdvance={() =>
            setDeactivateDialog({ ...deactivateDialog, stage: 'confirming' })
          }
          onConfirm={() => void handleDeactivateConfirm()}
        />
      )}
    </div>
  );
}

// Suppress unused-suppression noise until S9 imports the shared list.
void KNOWN_ROLES;
