// Authorized by HUB-1577 — R1 comment 14541 / D-HUB-SCOPE-027: this story owns the
// /console/dashboard route stub. HUB-1562 (E-FE-2) supersedes with real dashboard content.
export default function DashboardStub(): React.ReactElement {
  return (
    <div>
      <h1 className="font-heading text-2xl text-primary-navy mb-2">Dashboard</h1>
      <p className="font-body text-deep-charcoal">
        Console dashboard content delivered in E-FE-2 (HUB-1562).
      </p>
    </div>
  );
}
