// Authorized by HUB-1676 (E-FE-7 S3) — Ironclad 'coming soon' placeholder
// rendered by drill-in tab sub-routes whose real content hasn't shipped
// yet (S4 Liveness + Errors, S5 Queues + Webhooks).

interface SystemHealthTabPlaceholderProps {
  tabLabel: string;
  tabId: string;
  storyKey: string;
}

export function SystemHealthTabPlaceholder({
  tabLabel,
  tabId,
  storyKey,
}: SystemHealthTabPlaceholderProps): React.ReactElement {
  return (
    <div
      data-testid={`system-health-tab-placeholder-${tabId}`}
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-6"
    >
      <h2 className="mb-2 font-heading text-xl text-primary-navy">
        {tabLabel}
      </h2>
      <p className="text-sm font-body text-deep-charcoal/80">
        Coming soon — this tab is being built.
      </p>
      <p className="mt-2 text-xs font-body text-deep-charcoal/60">
        Owner story: <code>{storyKey}</code>. The tab URL is stable — the
        moment the story merges, this placeholder is replaced without
        breaking any deep-links.
      </p>
    </div>
  );
}
