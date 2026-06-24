// Authorized by HUB-1578 — placeholder route stub. Per D-HUB-SCOPE-027 pattern (originated
// HUB-1577 DashboardStub): HUB-1558 (E-FE-12 Audit Explorer) supersedes this with real content
// at the same /console/audit route.
export default function AuditStub(): React.ReactElement {
  return (
    <div>
      <h1 className="font-heading text-2xl text-primary-navy mb-2">Audit Log</h1>
      <p className="font-body text-deep-charcoal">
        Audit explorer content delivered in E-FE-12 (HUB-1558).
      </p>
    </div>
  );
}
