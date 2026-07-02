// Authorized by HUB-1667 (E-FE-6 S8) — Workflow hooks management sub-route
// at /console/settings/hooks. Hooks are tenant-scoped; the operator picks
// a tenant, the FE lists all hooks for that tenant, and each row expands
// to reveal the most-recent executions (triple-encoded status codes).
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Tenant picker source: no /admin/tenants endpoint exists at v0.1;
//      the tenant list is derived from the HUB-1700 portfolio aggregator
//      (distinct tenantId values across the products the operator can
//      see). This is a lossy view — tenants without products won't
//      surface here — but it matches the operator's practical scope.
//      HUB-1545 tech debt candidate: expose /admin/tenants.
//
//   2. Data model: story spec described { endpoint URL,
//      event_triggers[] (multi-select), secret }. The BE model is
//      { trigger_event_type (single string), action_config: {url,
//      hmac_secret} }. FE surfaces the single-trigger contract.
//      HUB-1545 tech debt candidate: extend BE to accept multiple
//      trigger types per hook.
//
//   3. Edit-in-place: no BE PUT for hooks (verified — only POST /
//      GET / DELETE / executions). Editing is archive+recreate. FE
//      surfaces this by omitting the Edit CTA — operators create a
//      replacement hook then archive the old one.
//
//   4. last_fired_at: not surfaced on the hook row shape; the FE
//      row surfaces the row's created_at + a link to expand for the
//      most-recent execution timestamp. Not a spec deviation strictly,
//      but noting the data source difference.
//
//   5. HTTPS-only enforcement: the BE already enforces
//      action_config.url must start with 'https://' at notifications.ts:426.
//      FE mirrors the check for immediate feedback.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../lib/api';
import { formatDate } from '../productDetail/pricing-formatters';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Workflow hooks | Settings | HUB Console';

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
  tenantName?: string;
}
interface PortfolioResponse {
  data: PortfolioProduct[];
}

interface TenantOption {
  tenantId: string;
  label: string;
}

interface HookRow {
  id: string;
  tenant_id: string;
  product_id: string | null;
  trigger_event_type: string;
  action_type: string;
  action_config: { url: string; hmac_secret: string };
  enabled: boolean;
  archived_at?: string | null;
  created_at: string;
}

interface HookExecution {
  id: string;
  hook_id: string;
  alert_event_id: string | null;
  status: string;
  status_code: number | null;
  duration_ms: number | null;
  error: string | null;
  attempted_at: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      tenants: TenantOption[];
      selected: string | null;
      hooks: HookRow[];
    };

function hooksPath(tenantId: string, includeArchived: boolean): string {
  const base = `/api/v1/admin/hooks/${tenantId}`;
  return includeArchived ? `${base}?includeArchived=true` : base;
}

interface StatusPillProps {
  code: number | null;
  status: string;
}

function StatusPill({ code, status }: StatusPillProps): React.ReactElement {
  if (code == null) {
    return (
      <span
        data-testid="hook-exec-status-null"
        className="inline-flex items-center rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs font-body text-deep-charcoal/70"
      >
        {status || 'unknown'}
      </span>
    );
  }
  if (code < 300) {
    return (
      <span
        data-testid={`hook-exec-status-${code}`}
        className="inline-flex items-center gap-1 rounded-full bg-seafoam/15 px-2 py-0.5 text-xs font-body text-seafoam"
      >
        <span aria-hidden="true">✓</span> {code}
      </span>
    );
  }
  if (code < 500) {
    return (
      <span
        data-testid={`hook-exec-status-${code}`}
        className="inline-flex items-center gap-1 rounded-full bg-accent-brass/15 px-2 py-0.5 text-xs font-body text-accent-brass"
      >
        <span aria-hidden="true">!</span> {code}
      </span>
    );
  }
  return (
    <span
      data-testid={`hook-exec-status-${code}`}
      className="inline-flex items-center gap-1 rounded-full bg-ironwake/15 px-2 py-0.5 text-xs font-body text-ironwake"
    >
      <span aria-hidden="true">✕</span> {code}
    </span>
  );
}

interface HookDraft {
  trigger_event_type: string;
  url: string;
  hmac_secret: string;
  enabled: boolean;
}

const DEFAULT_HOOK_DRAFT: HookDraft = {
  trigger_event_type: '',
  url: 'https://',
  hmac_secret: '',
  enabled: true,
};

interface NewHookModalProps {
  tenantId: string;
  onCancel: () => void;
  onCreated: () => void;
}

function NewHookModal({
  tenantId,
  onCancel,
  onCreated,
}: NewHookModalProps): React.ReactElement {
  const [draft, setDraft] = useState<HookDraft>(DEFAULT_HOOK_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    if (!draft.trigger_event_type.trim()) {
      nextErrors.trigger_event_type = 'Trigger event type is required.';
    }
    if (!draft.url.startsWith('https://')) {
      nextErrors.url = 'Endpoint must be an https:// URL.';
    }
    if (!draft.hmac_secret.trim()) {
      nextErrors.hmac_secret = 'HMAC secret is required.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await apiClient.post(`/api/v1/admin/hooks/${tenantId}`, {
        trigger_event_type: draft.trigger_event_type.trim(),
        action_config: {
          url: draft.url,
          hmac_secret: draft.hmac_secret,
        },
        enabled: draft.enabled,
      });
      onCreated();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-hook-heading"
      data-testid="new-hook-modal"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="new-hook-heading"
          className="mb-3 font-heading text-lg text-primary-navy"
        >
          New workflow hook
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Trigger event type
            <input
              data-testid="new-hook-trigger"
              type="text"
              value={draft.trigger_event_type}
              onChange={(e) =>
                setDraft({ ...draft, trigger_event_type: e.target.value })
              }
              aria-invalid={errors.trigger_event_type ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.trigger_event_type && (
              <span
                data-testid="new-hook-trigger-err"
                className="text-xs text-ironwake"
              >
                {errors.trigger_event_type}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Endpoint URL (HTTPS only)
            <input
              data-testid="new-hook-url"
              type="text"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              aria-invalid={errors.url ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.url && (
              <span data-testid="new-hook-url-err" className="text-xs text-ironwake">
                {errors.url}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            HMAC secret
            <input
              data-testid="new-hook-secret"
              type="password"
              value={draft.hmac_secret}
              onChange={(e) => setDraft({ ...draft, hmac_secret: e.target.value })}
              aria-invalid={errors.hmac_secret ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.hmac_secret && (
              <span
                data-testid="new-hook-secret-err"
                className="text-xs text-ironwake"
              >
                {errors.hmac_secret}
              </span>
            )}
            <span className="text-xs text-deep-charcoal/60">
              The secret is stored encrypted server-side and never surfaced
              again in list responses. To rotate, archive this hook and create
              a new one.
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            <input
              type="checkbox"
              data-testid="new-hook-enabled"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            Enabled
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="new-hook-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="new-hook-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="new-hook-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Creating…' : 'Create hook'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ArchiveDialogState {
  hook: HookRow;
  stage: 'ask' | 'confirming';
  submitting: boolean;
  errorMessage: string | null;
}

interface ArchiveDialogProps {
  state: ArchiveDialogState;
  onCancel: () => void;
  onAdvance: () => void;
  onConfirm: () => void;
}

function ArchiveDialog({
  state,
  onCancel,
  onAdvance,
  onConfirm,
}: ArchiveDialogProps): React.ReactElement {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="archive-hook-heading"
      data-testid="archive-hook-dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="archive-hook-heading"
          className="mb-2 font-heading text-lg text-primary-navy"
        >
          Archive hook — {state.hook.trigger_event_type}
        </h2>
        <p className="text-sm font-body text-deep-charcoal">
          This will stop the hook from firing on future events. Existing
          execution history is preserved for audit.
        </p>
        {state.stage === 'confirming' && (
          <div
            role="alert"
            data-testid="archive-hook-confirm-panel"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            Click <strong>Archive now</strong> once more to commit.
          </div>
        )}
        {state.errorMessage && (
          <div
            role="alert"
            data-testid="archive-hook-error"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {state.errorMessage}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="archive-hook-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="archive-hook-confirm"
            onClick={state.stage === 'ask' ? onAdvance : onConfirm}
            disabled={state.submitting}
            className="rounded bg-ironwake px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-ironwake/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {state.submitting
              ? 'Archiving…'
              : state.stage === 'ask'
                ? 'Continue to confirm'
                : 'Archive now'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ExecutionsPanelProps {
  tenantId: string;
  hookId: string;
}

function ExecutionsPanel({
  tenantId,
  hookId,
}: ExecutionsPanelProps): React.ReactElement {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; executions: HookExecution[] }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .get<HookExecution[]>(
        `/api/v1/admin/hooks/${tenantId}/${hookId}/executions`,
      )
      .then((executions) => {
        if (cancelled) return;
        setState({ kind: 'ready', executions: executions.slice(0, 20) });
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load executions';
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, hookId]);

  if (state.kind === 'loading') {
    return (
      <div
        data-testid={`hook-executions-loading-${hookId}`}
        className="rounded bg-deep-charcoal/5 p-2 text-xs font-body text-deep-charcoal/60"
      >
        Loading executions…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        data-testid={`hook-executions-error-${hookId}`}
        className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
      >
        {state.message}
      </div>
    );
  }
  if (state.executions.length === 0) {
    return (
      <p
        data-testid={`hook-executions-empty-${hookId}`}
        className="text-xs font-body text-deep-charcoal/60"
      >
        No recent executions.
      </p>
    );
  }
  return (
    <ul
      data-testid={`hook-executions-list-${hookId}`}
      className="flex flex-col gap-1"
    >
      {state.executions.map((e) => (
        <li
          key={e.id}
          data-testid={`hook-execution-${e.id}`}
          className="flex items-center justify-between gap-2 rounded border border-deep-charcoal/10 bg-sailcloth p-2 text-xs font-body text-deep-charcoal"
        >
          <div className="min-w-0 flex-1">
            <p>{formatDate(e.attempted_at)}</p>
            {e.error && (
              <p
                data-testid={`hook-execution-error-${e.id}`}
                className="text-ironwake"
              >
                {e.error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {e.duration_ms != null && (
              <span className="text-deep-charcoal/60">{e.duration_ms}ms</span>
            )}
            <StatusPill code={e.status_code} status={e.status} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function WorkflowHooksManager(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogState | null>(
    null,
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const loadTenants = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await apiClient.get<PortfolioResponse>(PORTFOLIO_PATH);
      const uniq = new Map<string, string>();
      for (const p of res.data) {
        if (!uniq.has(p.tenantId)) {
          uniq.set(p.tenantId, p.tenantName ?? p.tenantId);
        }
      }
      const tenants: TenantOption[] = Array.from(uniq.entries()).map(
        ([tenantId, label]) => ({ tenantId, label }),
      );
      setState({ kind: 'ready', tenants, selected: null, hooks: [] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load tenants';
      setState({ kind: 'error', message });
    }
  }, []);

  const loadHooks = useCallback(
    async (tenantId: string): Promise<void> => {
      try {
        const hooks = await apiClient.get<HookRow[]>(
          hooksPath(tenantId, includeArchived),
        );
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, selected: tenantId, hooks }
            : prev,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load hooks';
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, selected: tenantId, hooks: [] }
            : { kind: 'error', message },
        );
      }
    },
    [includeArchived],
  );

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  const selectedTenantId = state.kind === 'ready' ? state.selected : null;
  useEffect(() => {
    if (state.kind === 'ready' && state.selected) {
      void loadHooks(state.selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived, selectedTenantId, loadHooks, state.kind]);

  const handleArchiveConfirm = useCallback(async (): Promise<void> => {
    if (!archiveDialog || state.kind !== 'ready' || !state.selected) return;
    setArchiveDialog({
      ...archiveDialog,
      submitting: true,
      errorMessage: null,
    });
    try {
      await apiClient.delete(
        `/api/v1/admin/hooks/${state.selected}/${archiveDialog.hook.id}`,
      );
      setArchiveDialog(null);
      void loadHooks(state.selected);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Archive failed.';
      setArchiveDialog({
        ...archiveDialog,
        submitting: false,
        errorMessage: message,
      });
    }
  }, [archiveDialog, state, loadHooks]);

  const toggleExpanded = useCallback((hookId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(hookId)) next.delete(hookId);
      else next.add(hookId);
      return next;
    });
  }, []);

  const sortedHooks = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return [...state.hooks].sort((a, b) => {
      const aArchived = (a.archived_at ?? null) === null ? 0 : 1;
      const bArchived = (b.archived_at ?? null) === null ? 0 : 1;
      if (aArchived !== bArchived) return aArchived - bArchived;
      return a.created_at.localeCompare(b.created_at);
    });
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div id="main-content" data-testid="hooks-page">
        <div
          data-testid="hooks-skeleton"
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
        data-testid="hooks-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load workflow hooks.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="hooks-retry"
          onClick={() => void loadTenants()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div id="main-content" data-testid="hooks-page" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">Workflow hooks</h1>
        <p className="text-sm font-body text-deep-charcoal/70">
          Per-tenant webhook hooks with HMAC signing and execution history.
        </p>
      </header>

      <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
        Tenant
        <select
          data-testid="hooks-tenant-picker"
          value={state.selected ?? ''}
          onChange={(e) => {
            if (e.target.value) void loadHooks(e.target.value);
          }}
          className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          <option value="">Select a tenant…</option>
          {state.tenants.map((t) => (
            <option key={t.tenantId} value={t.tenantId}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      {state.selected && (
        <>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
              <input
                type="checkbox"
                data-testid="hooks-show-archived"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              Show archived
            </label>
            <button
              type="button"
              data-testid="hooks-new"
              onClick={() => setShowNew(true)}
              className="rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              New hook
            </button>
          </div>

          {sortedHooks.length === 0 ? (
            <div
              data-testid="hooks-empty"
              className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
            >
              No workflow hooks for this tenant yet. Click{' '}
              <strong>New hook</strong> to add one.
            </div>
          ) : (
            <ul data-testid="hooks-list" className="flex flex-col gap-2">
              {sortedHooks.map((h) => (
                <li
                  key={h.id}
                  data-testid={`hooks-row-${h.id}`}
                  className={
                    h.archived_at
                      ? 'rounded-md border border-deep-charcoal/15 bg-deep-charcoal/5 p-3'
                      : 'rounded-md border border-deep-charcoal/15 bg-sailcloth p-3'
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-heading text-base text-primary-navy">
                        {h.trigger_event_type}
                      </p>
                      <p className="truncate font-mono text-xs text-deep-charcoal/60">
                        {h.action_config.url}
                      </p>
                      <p className="text-xs font-body text-deep-charcoal/60">
                        Created {formatDate(h.created_at)}
                        {h.archived_at
                          ? ` · Archived ${formatDate(h.archived_at)}`
                          : h.enabled
                            ? ' · enabled'
                            : ' · disabled'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid={`hooks-toggle-execs-${h.id}`}
                        aria-expanded={expanded.has(h.id)}
                        onClick={() => toggleExpanded(h.id)}
                        className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                      >
                        {expanded.has(h.id) ? 'Hide executions' : 'Executions'}
                      </button>
                      {!h.archived_at && (
                        <button
                          type="button"
                          data-testid={`hooks-archive-${h.id}`}
                          onClick={() =>
                            setArchiveDialog({
                              hook: h,
                              stage: 'ask',
                              submitting: false,
                              errorMessage: null,
                            })
                          }
                          className="rounded border border-ironwake/40 px-2 py-1 text-xs font-body text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                        >
                          Archive
                        </button>
                      )}
                    </div>
                  </div>
                  {expanded.has(h.id) && state.selected && (
                    <div className="mt-2">
                      <ExecutionsPanel
                        tenantId={state.selected}
                        hookId={h.id}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {showNew && state.selected && (
        <NewHookModal
          tenantId={state.selected}
          onCancel={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            if (state.selected) void loadHooks(state.selected);
          }}
        />
      )}
      {archiveDialog && (
        <ArchiveDialog
          state={archiveDialog}
          onCancel={() => setArchiveDialog(null)}
          onAdvance={() =>
            setArchiveDialog({ ...archiveDialog, stage: 'confirming' })
          }
          onConfirm={() => void handleArchiveConfirm()}
        />
      )}
    </div>
  );
}
