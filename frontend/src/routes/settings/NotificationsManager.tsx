// Authorized by HUB-1665 (E-FE-6 S6) — Notifications channel management
// sub-route at /console/settings/notifications. Fetches the operator's
// products via the HUB-1700 portfolio aggregator, lets the operator pick
// one, then lists / creates / edits / soft-archives channels via the
// tenant-scoped notifications endpoints (upsert on POST; PUT for content;
// DELETE soft-archives per HUB-1661).
//
// Spec deviations (documented per ironclad-engineer):
//
//   1. Channel types: the story spec named email / slack / webhook; the
//      BE VALID_CHANNEL_TYPES set is { email, webhook, in_app } — no
//      dedicated 'slack' type. Slack notifications are routed through
//      a webhook channel with a Slack-shaped config. Dropdown mirrors
//      the BE contract. HUB-1545 tech debt candidate: extend the BE
//      enum with 'slack' once we have a Slack-specific config schema.
//
//   2. Per-type config catalog: the spec asked for typed sub-modals per
//      channel_type (email address list, Slack channel name, etc.).
//      v0.1 renders a raw JSON textarea for the config so the FE stays
//      unblocked while the shape stabilises; the BE validateChannelConfig
//      is the enforcer. HUB-1545 tech debt candidate: build the typed
//      sub-form catalog once the shapes are locked.
//
//   3. Test-send endpoint: no BE surface exists at v0.1. The 'Send test'
//      CTA is rendered but disabled with a tooltip pointing at the tech
//      debt. HUB-1545 tech debt candidate: file POST
//      /admin/notifications/:tenantId/:productId/channels/:channelId/test.
//
//   4. POST /channels is upsert-on-conflict (BE ON CONFLICT DO UPDATE).
//      The FE UI treats New Channel as an unconditional create; if the
//      operator saves a second channel of the same type on the same
//      product, the BE quietly updates the existing row. Documented so
//      testers understand why the 'created' vs 'updated' status code
//      differs.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api';
import { formatDate } from '../productDetail/pricing-formatters';

const PORTFOLIO_PATH = '/api/v1/admin/portfolio/products';
const PAGE_TITLE = 'Notifications | Settings | HUB Console';

interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
}
interface PortfolioResponse {
  data: PortfolioProduct[];
}

type ChannelType = 'email' | 'webhook' | 'in_app';
const CHANNEL_TYPES: readonly ChannelType[] = ['email', 'webhook', 'in_app'];

interface ChannelRow {
  id: string;
  tenant_id: string;
  product_id: string;
  channel_type: ChannelType;
  config: Record<string, unknown>;
  enabled: boolean;
  archived_at: string | null;
  created_at: string;
}

interface ChannelsResponse {
  channels: ChannelRow[];
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      products: PortfolioProduct[];
      selected: PortfolioProduct | null;
      channels: ChannelRow[];
    };

function channelsPath(product: PortfolioProduct, includeArchived: boolean): string {
  const base = `/api/v1/admin/notifications/${product.tenantId}/${product.productId}/channels`;
  return includeArchived ? `${base}?includeArchived=true` : base;
}

function ChannelTypeBadge({ type }: { type: ChannelType }): React.ReactElement {
  if (type === 'email') {
    return (
      <span
        data-testid="channel-type-email"
        className="inline-flex items-center gap-1 rounded-full border border-primary-navy/40 bg-primary-navy/10 px-2 py-0.5 text-xs font-body text-primary-navy"
      >
        <span aria-hidden="true">✉</span> email
      </span>
    );
  }
  if (type === 'webhook') {
    return (
      <span
        data-testid="channel-type-webhook"
        className="inline-flex items-center gap-1 rounded-full border border-seafoam/40 bg-seafoam/10 px-2 py-0.5 text-xs font-body text-seafoam"
      >
        <span aria-hidden="true">⚙</span> webhook
      </span>
    );
  }
  return (
    <span
      data-testid="channel-type-in_app"
      className="inline-flex items-center gap-1 rounded-full border border-deep-charcoal/30 bg-deep-charcoal/10 px-2 py-0.5 text-xs font-body text-deep-charcoal"
    >
      <span aria-hidden="true">◈</span> in-app
    </span>
  );
}

interface ChannelDraft {
  channel_type: ChannelType;
  configJson: string;
  hmac_secret: string;
  enabled: boolean;
}

const DEFAULT_DRAFT: ChannelDraft = {
  channel_type: 'email',
  configJson: '{}',
  hmac_secret: '',
  enabled: true,
};

interface ChannelModalProps {
  mode: 'new' | 'edit';
  product: PortfolioProduct;
  channel?: ChannelRow;
  onCancel: () => void;
  onSaved: () => void;
}

function ChannelModal({
  mode,
  product,
  channel,
  onCancel,
  onSaved,
}: ChannelModalProps): React.ReactElement {
  const [draft, setDraft] = useState<ChannelDraft>(() => {
    if (!channel) return DEFAULT_DRAFT;
    return {
      channel_type: channel.channel_type,
      configJson: JSON.stringify(channel.config, null, 2),
      hmac_secret: '',
      enabled: channel.enabled,
    };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const nextErrors: Record<string, string> = {};
    let parsedConfig: Record<string, unknown> = {};
    try {
      const raw = draft.configJson.trim();
      const parsed = raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        nextErrors.configJson = 'Config must be a JSON object.';
      } else {
        parsedConfig = parsed as Record<string, unknown>;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid JSON';
      nextErrors.configJson = `Invalid JSON: ${message}`;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerError(null);
    try {
      if (mode === 'new') {
        await apiClient.post(
          `/api/v1/admin/notifications/${product.tenantId}/${product.productId}/channels`,
          {
            channel_type: draft.channel_type,
            config: parsedConfig,
            hmac_secret: draft.hmac_secret.length > 0 ? draft.hmac_secret : null,
            enabled: draft.enabled,
          },
        );
      } else if (channel) {
        await apiClient.put(
          `/api/v1/admin/notifications/${product.tenantId}/${product.productId}/channels/${channel.id}`,
          {
            config: parsedConfig,
            hmac_secret: draft.hmac_secret.length > 0 ? draft.hmac_secret : null,
            enabled: draft.enabled,
          },
        );
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
      aria-labelledby="channel-modal-heading"
      data-testid={`channel-modal-${mode}`}
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="channel-modal-heading"
          className="mb-3 font-heading text-lg text-primary-navy"
        >
          {mode === 'new' ? 'New channel' : `Edit ${channel?.channel_type} channel`}
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Channel type
            <select
              data-testid="channel-modal-type"
              value={draft.channel_type}
              onChange={(e) =>
                setDraft({ ...draft, channel_type: e.target.value as ChannelType })
              }
              disabled={mode === 'edit'}
              className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass disabled:opacity-60"
            >
              {CHANNEL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            Config (JSON)
            <textarea
              data-testid="channel-modal-config"
              value={draft.configJson}
              rows={5}
              onChange={(e) =>
                setDraft({ ...draft, configJson: e.target.value })
              }
              aria-invalid={errors.configJson ? true : undefined}
              className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
            {errors.configJson && (
              <span
                data-testid="channel-modal-config-err"
                className="text-xs text-ironwake"
              >
                {errors.configJson}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
            HMAC secret {mode === 'edit' && '(leave empty to keep the current secret)'}
            <input
              data-testid="channel-modal-hmac"
              type="password"
              value={draft.hmac_secret}
              onChange={(e) => setDraft({ ...draft, hmac_secret: e.target.value })}
              className="rounded border border-deep-charcoal/20 p-2 font-mono text-xs text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
            />
          </label>
          <label className="flex items-center gap-2 text-sm font-body text-deep-charcoal/80">
            <input
              type="checkbox"
              data-testid="channel-modal-enabled"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            Enabled
          </label>
          {serverError && (
            <div
              role="alert"
              data-testid="channel-modal-server-error"
              className="rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
            >
              {serverError}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="channel-modal-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="channel-modal-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            {submitting ? 'Saving…' : mode === 'new' ? 'Create channel' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ArchiveDialogState {
  channel: ChannelRow;
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
      aria-labelledby="archive-channel-heading"
      data-testid="archive-channel-dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-charcoal/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-sailcloth p-4 shadow-lg">
        <h2
          id="archive-channel-heading"
          className="mb-2 font-heading text-lg text-primary-navy"
        >
          Archive {state.channel.channel_type} channel
        </h2>
        <p className="text-sm font-body text-deep-charcoal">
          Archive this channel? It will be hidden from the active list but
          preserved for audit history.
        </p>
        {state.stage === 'confirming' && (
          <div
            role="alert"
            data-testid="archive-channel-confirm-panel"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            Click <strong>Archive now</strong> once more to commit.
          </div>
        )}
        {state.errorMessage && (
          <div
            role="alert"
            data-testid="archive-channel-error"
            className="mt-2 rounded border border-ironwake/40 bg-ironwake/5 p-2 text-xs font-body text-ironwake"
          >
            {state.errorMessage}
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="archive-channel-cancel"
            onClick={onCancel}
            className="rounded border border-deep-charcoal/20 px-3 py-1.5 text-sm font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="archive-channel-confirm"
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

export default function NotificationsManager(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<ChannelRow | null>(null);
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogState | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = prev;
    };
  }, []);

  const loadProducts = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await apiClient.get<PortfolioResponse>(PORTFOLIO_PATH);
      setState({
        kind: 'ready',
        products: res.data,
        selected: null,
        channels: [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load products';
      setState({ kind: 'error', message });
    }
  }, []);

  const loadChannels = useCallback(
    async (product: PortfolioProduct): Promise<void> => {
      try {
        const res = await apiClient.get<ChannelsResponse>(
          channelsPath(product, includeArchived),
        );
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, selected: product, channels: res.channels }
            : prev,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load channels';
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, selected: product, channels: [] }
            : { kind: 'error', message },
        );
      }
    },
    [includeArchived],
  );

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const selectedProductId =
    state.kind === 'ready' ? (state.selected?.productId ?? null) : null;
  useEffect(() => {
    if (state.kind === 'ready' && state.selected) {
      void loadChannels(state.selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived, selectedProductId, loadChannels, state.kind]);

  const handleSelectProduct = useCallback(
    (productId: string) => {
      if (state.kind !== 'ready') return;
      const product = state.products.find((p) => p.productId === productId);
      if (!product) return;
      void loadChannels(product);
    },
    [state, loadChannels],
  );

  const handleArchiveConfirm = useCallback(async (): Promise<void> => {
    if (!archiveDialog || state.kind !== 'ready' || !state.selected) return;
    setArchiveDialog({
      ...archiveDialog,
      submitting: true,
      errorMessage: null,
    });
    try {
      await apiClient.delete(
        `/api/v1/admin/notifications/${state.selected.tenantId}/${state.selected.productId}/channels/${archiveDialog.channel.id}`,
      );
      setArchiveDialog(null);
      void loadChannels(state.selected);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Archive failed.';
      setArchiveDialog({
        ...archiveDialog,
        submitting: false,
        errorMessage: message,
      });
    }
  }, [archiveDialog, state, loadChannels]);

  if (state.kind === 'loading') {
    return (
      <div id="main-content" data-testid="notifications-page">
        <div
          data-testid="notifications-skeleton"
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
        data-testid="notifications-error"
        className="rounded-md border border-ironwake/40 bg-ironwake/5 p-4 text-sm font-body text-ironwake"
      >
        <p className="font-medium">Couldn’t load notifications.</p>
        <p className="mt-1">{state.message}</p>
        <button
          type="button"
          data-testid="notifications-retry"
          onClick={() => void loadProducts()}
          className="mt-2 rounded border border-ironwake/40 px-3 py-1 text-sm hover:bg-ironwake/10 focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div id="main-content" data-testid="notifications-page" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-primary-navy">Notifications</h1>
        <p className="text-sm font-body text-deep-charcoal/70">
          Per-product notification channels (email, webhook, in-app).
        </p>
      </header>

      <label className="flex flex-col gap-1 text-sm font-body text-deep-charcoal/80">
        Product
        <select
          data-testid="notifications-product-picker"
          value={state.selected?.productId ?? ''}
          onChange={(e) => handleSelectProduct(e.target.value)}
          className="rounded border border-deep-charcoal/20 p-2 text-sm text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          <option value="">Select a product…</option>
          {state.products.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.productName}
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
                data-testid="notifications-show-archived"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              Show archived
            </label>
            <button
              type="button"
              data-testid="notifications-new"
              onClick={() => setShowNew(true)}
              className="rounded-md bg-primary-navy px-3 py-1.5 text-sm font-body text-sailcloth hover:bg-primary-navy/90 focus:outline-none focus:ring-2 focus:ring-accent-brass"
            >
              New channel
            </button>
          </div>

          {state.channels.length === 0 ? (
            <div
              data-testid="notifications-empty"
              className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-4 text-sm font-body text-deep-charcoal/70"
            >
              No channels defined for this product yet.
            </div>
          ) : (
            <ul data-testid="notifications-list" className="flex flex-col gap-2">
              {state.channels.map((c) => (
                <li
                  key={c.id}
                  data-testid={`notifications-row-${c.id}`}
                  className={
                    c.archived_at
                      ? 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-deep-charcoal/5 p-3'
                      : 'flex items-center justify-between gap-3 rounded-md border border-deep-charcoal/15 bg-sailcloth p-3'
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <ChannelTypeBadge type={c.channel_type} />
                      {c.enabled ? (
                        <span
                          data-testid={`channel-enabled-${c.id}`}
                          className="rounded-full bg-seafoam/15 px-2 py-0.5 text-xs font-body text-seafoam"
                        >
                          enabled
                        </span>
                      ) : (
                        <span
                          data-testid={`channel-disabled-${c.id}`}
                          className="rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs font-body text-deep-charcoal/70"
                        >
                          disabled
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs font-body text-deep-charcoal/60">
                      Created: {formatDate(c.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid={`notifications-test-${c.id}`}
                      disabled
                      title="Test-send endpoint arrives in a future BE addendum."
                      className="cursor-not-allowed rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal/60"
                    >
                      Send test
                    </button>
                    {!c.archived_at && (
                      <>
                        <button
                          type="button"
                          data-testid={`notifications-edit-${c.id}`}
                          onClick={() => setEditing(c)}
                          className="rounded border border-deep-charcoal/20 px-2 py-1 text-xs font-body text-deep-charcoal hover:bg-deep-charcoal/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          data-testid={`notifications-archive-${c.id}`}
                          onClick={() =>
                            setArchiveDialog({
                              channel: c,
                              stage: 'ask',
                              submitting: false,
                              errorMessage: null,
                            })
                          }
                          className="rounded border border-ironwake/40 px-2 py-1 text-xs font-body text-ironwake hover:bg-ironwake/5 focus:outline-none focus:ring-2 focus:ring-accent-brass"
                        >
                          Archive
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {showNew && state.selected && (
        <ChannelModal
          mode="new"
          product={state.selected}
          onCancel={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            if (state.selected) void loadChannels(state.selected);
          }}
        />
      )}
      {editing && state.selected && (
        <ChannelModal
          mode="edit"
          product={state.selected}
          channel={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            if (state.selected) void loadChannels(state.selected);
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
