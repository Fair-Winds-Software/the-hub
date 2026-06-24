// Authorized by HUB-1578 — placeholder route stub. Per D-HUB-SCOPE-027 pattern (originated
// HUB-1577 DashboardStub): HUB-1564 (E-FE-6 Settings) supersedes this with real content at
// the same /console/settings route.
export default function SettingsStub(): React.ReactElement {
  return (
    <div>
      <h1 className="font-heading text-2xl text-primary-navy mb-2">Settings</h1>
      <p className="font-body text-deep-charcoal">
        HUB Settings content delivered in E-FE-6 (HUB-1564).
      </p>
    </div>
  );
}
