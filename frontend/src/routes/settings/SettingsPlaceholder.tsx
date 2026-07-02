// Authorized by HUB-1662 (E-FE-6 S3) — Ironclad 'coming soon' placeholder
// rendered by sub-routes whose real content hasn't shipped yet (S4..S8).
// Each un-merged sub-route mounts this component with its own label so
// operators see a clear, section-specific message instead of a broken
// route.

interface SettingsPlaceholderProps {
  sectionLabel: string;
  sectionId: string;
  storyKey: string;
}

export function SettingsPlaceholder({
  sectionLabel,
  sectionId,
  storyKey,
}: SettingsPlaceholderProps): React.ReactElement {
  return (
    <div
      data-testid={`settings-placeholder-${sectionId}`}
      className="rounded-md border border-deep-charcoal/15 bg-sailcloth p-6"
    >
      <h1 className="mb-2 font-heading text-2xl text-primary-navy">
        {sectionLabel}
      </h1>
      <p className="text-sm font-body text-deep-charcoal/80">
        Coming soon — this section is being built.
      </p>
      <p className="mt-2 text-xs font-body text-deep-charcoal/60">
        Owner story: <code>{storyKey}</code>. Until it ships, you can still
        deep-link to this page — it will start rendering the real content the
        moment the story merges to <code>main</code>.
      </p>
    </div>
  );
}
