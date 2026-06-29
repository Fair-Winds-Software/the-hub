// Authorized by HUB-1608 (E-FE-3 S8) — Notifications tab inside the HUB-1604
// product detail. Read-only view of notification channels + escalation rules
// scoped to the product. Edit lives in HUB-1564 (E-FE-6 Settings).
//
// Spec deviations (documented per ironclad-engineer):
// 1. Endpoint shape: spec named GET /api/v1/admin/products/:productId/
//    notifications. The actual BE surface (HUB-1502 + HUB-1503) is two
//    endpoints scoped by tenantId + productId:
//      - GET /api/v1/admin/notifications/:tenantId/:productId/channels
//      - GET /api/v1/admin/escalation/:tenantId/:productId/rules
//    We fetch both in parallel and combine. Needs tenantId from the parent's
//    PortfolioProduct.
// 2. Partial-OK degradation: if one endpoint fails and the other succeeds,
//    we still render the loaded section + an error pill for the failed one.
//    Better than blanking both sections on a single 5xx.
// 3. Empty state: "No notifications configured" + secondary CTA links to
//    /console/settings (HUB-1564 owner) per the spec.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../lib/api';

interface NotificationChannel {
  id: string;
  tenant_id: string;
  product_id: string;
  channel_type: string;
  config: Record<string, unknown>;
  hmac_secret: string | null;
  enabled: boolean;
  created_at: string;
}

interface EscalationRule {
  id: string;
  tenant_id: string;
  product_id: string;
  alert_type: string;
  tier: number;
  threshold_minutes: number;
  escalation_contacts: Array<{ type: string; value: string }>;
}

interface SectionState<T> {
  kind: 'loading' | 'error' | 'ready';
  items: T[];
  error: string | null;
}

const CHANNELS_PATH = (tenantId: string, productId: string): string =>
  `/api/v1/admin/notifications/${tenantId}/${productId}/channels`;
const ESCALATION_PATH = (tenantId: string, productId: string): string =>
  `/api/v1/admin/escalation/${tenantId}/${productId}/rules`;

function channelRecipient(channel: NotificationChannel): string {
  const c = channel.config;
  if (channel.channel_type === 'email' && typeof c.to === 'string') return c.to;
  if (channel.channel_type === 'webhook' && typeof c.url === 'string') return c.url;
  if (channel.channel_type === 'in_app') return '(in-app feed)';
  return '—';
}

function EnabledBadge({ enabled }: { enabled: boolean }): React.ReactElement {
  return (
    <span
      data-testid={enabled ? 'channel-enabled' : 'channel-disabled'}
      className={
        enabled
          ? 'inline-flex items-center rounded-full bg-seafoam/15 px-2 py-0.5 text-xs text-seafoam'
          : 'inline-flex items-center rounded-full bg-deep-charcoal/10 px-2 py-0.5 text-xs text-deep-charcoal/70'
      }
    >
      {enabled ? 'enabled' : 'disabled'}
    </span>
  );
}

export interface NotificationsTabProps {
  productId: string;
  tenantId: string;
}

export function NotificationsTab({
  productId,
  tenantId,
}: NotificationsTabProps): React.ReactElement {
  const [channels, setChannels] = useState<SectionState<NotificationChannel>>({
    kind: 'loading',
    items: [],
    error: null,
  });
  const [rules, setRules] = useState<SectionState<EscalationRule>>({
    kind: 'loading',
    items: [],
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setChannels({ kind: 'loading', items: [], error: null });
    setRules({ kind: 'loading', items: [], error: null });

    void apiClient
      .get<{ channels: NotificationChannel[] }>(
        CHANNELS_PATH(tenantId, productId),
      )
      .then((res) => {
        if (cancelled) return;
        setChannels({ kind: 'ready', items: res.channels, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load channels';
        setChannels({ kind: 'error', items: [], error: message });
      });

    void apiClient
      .get<{ rules: EscalationRule[] }>(ESCALATION_PATH(tenantId, productId))
      .then((res) => {
        if (cancelled) return;
        setRules({ kind: 'ready', items: res.rules, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Failed to load escalation rules';
        setRules({ kind: 'error', items: [], error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [tenantId, productId]);

  const isLoadingAll =
    channels.kind === 'loading' && rules.kind === 'loading';
  const isEmptyAll =
    channels.kind === 'ready' &&
    rules.kind === 'ready' &&
    channels.items.length === 0 &&
    rules.items.length === 0;

  if (isLoadingAll) {
    return (
      <div
        data-testid="notifications-tab-loading"
        className="p-4 text-sm font-body text-deep-charcoal/70"
      >
        Loading notifications config…
      </div>
    );
  }

  if (isEmptyAll) {
    return (
      <div data-testid="notifications-empty-state" className="flex flex-col items-start gap-2 p-4 text-sm font-body text-deep-charcoal/80">
        <p>No notifications configured for this product.</p>
        <Link
          to="/console/settings"
          data-testid="notifications-empty-cta"
          className="underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
        >
          Configure notifications in Settings
        </Link>
      </div>
    );
  }

  return (
    <div data-testid="notifications-tab" className="flex flex-col gap-6 p-4">
      <section data-testid="notifications-channels-section">
        <h3 className="font-heading text-lg text-primary-navy mb-2">Channels</h3>
        {channels.kind === 'error' && (
          <div
            role="alert"
            data-testid="notifications-channels-error"
            className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
          >
            Could not load channels: {channels.error}
          </div>
        )}
        {channels.kind === 'ready' && channels.items.length === 0 && (
          <p
            data-testid="notifications-channels-empty"
            className="text-sm font-body text-deep-charcoal/70"
          >
            No channels configured.
          </p>
        )}
        {channels.kind === 'ready' && channels.items.length > 0 && (
          <ul
            data-testid="notifications-channels-list"
            className="flex flex-col gap-1"
          >
            {channels.items.map((c) => (
              <li
                key={c.id}
                data-testid={`channel-${c.id}`}
                className="grid grid-cols-[120px_1fr_auto] items-center gap-3 border-b border-deep-charcoal/10 py-2 last:border-b-0"
              >
                <span className="font-body text-sm font-medium text-primary-navy">
                  {c.channel_type}
                </span>
                <span className="font-body text-sm text-deep-charcoal break-all">
                  {channelRecipient(c)}
                </span>
                <EnabledBadge enabled={c.enabled} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="notifications-escalation-section">
        <h3 className="font-heading text-lg text-primary-navy mb-2">
          Escalation Rules
        </h3>
        {rules.kind === 'error' && (
          <div
            role="alert"
            data-testid="notifications-rules-error"
            className="rounded-md border border-ironwake/40 bg-ironwake/5 p-3 text-sm font-body text-ironwake"
          >
            Could not load escalation rules: {rules.error}
          </div>
        )}
        {rules.kind === 'ready' && rules.items.length === 0 && (
          <p
            data-testid="notifications-rules-empty"
            className="text-sm font-body text-deep-charcoal/70"
          >
            No escalation rules configured.
          </p>
        )}
        {rules.kind === 'ready' && rules.items.length > 0 && (
          <ul
            data-testid="notifications-rules-list"
            className="flex flex-col gap-1"
          >
            {rules.items.map((r) => (
              <li
                key={r.id}
                data-testid={`rule-${r.id}`}
                className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-deep-charcoal/10 py-2 last:border-b-0"
              >
                <span className="font-body text-sm font-medium text-primary-navy">
                  {r.alert_type}
                </span>
                <span className="font-body text-xs text-deep-charcoal/70">
                  tier {r.tier}
                </span>
                <span className="font-body text-xs text-deep-charcoal/70">
                  {r.threshold_minutes}m threshold
                </span>
                <span className="font-body text-xs text-deep-charcoal/70">
                  {r.escalation_contacts.length} contact
                  {r.escalation_contacts.length === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
