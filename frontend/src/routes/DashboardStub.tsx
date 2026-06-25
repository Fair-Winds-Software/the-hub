// Authorized by HUB-1577 — R1 comment 14541 / D-HUB-SCOPE-027: this story registered the
// /console/dashboard route stub at App.tsx.
// Authorized by HUB-1694 — Welcome card content (operator email + role + sidebar nudge) +
// landmark region for AT navigation. HUB-1562 (E-FE-2) replaces this stub via HUB-1644.
//
// A11y note: AC#3 specifies a `<main>` landmark, but ConsoleShell already wraps the Outlet
// in `<main>` and HTML5 forbids nested `<main>` elements (each document gets one). We
// satisfy the landmark intent with `<section aria-label="Dashboard placeholder">` — an
// aria-labeled <section> IS a region landmark for assistive tech (no explicit role needed;
// the implicit role becomes "region" when the section has an accessible name).
import { useOperator } from '../stores/sessionStore';

export default function DashboardStub(): React.ReactElement {
  const operator = useOperator();
  const isSuper = operator?.role === 'super_admin';

  return (
    <section
      aria-label="Dashboard placeholder"
      className="flex items-start justify-center pt-12"
    >
      <div className="max-w-xl w-full bg-sailcloth border border-deep-charcoal/10 rounded-lg shadow-md p-8">
        <h1 className="font-heading text-2xl text-primary-navy mb-4">Welcome to HUB</h1>
        {operator && (
          <div className="flex items-center gap-3 mb-4">
            <span className="font-body text-sm text-deep-charcoal" data-testid="stub-operator-email">
              {operator.email}
            </span>
            <span
              aria-label={`Role: ${operator.role}`}
              data-testid="stub-role-badge"
              className={`font-mono text-xs uppercase px-2 py-0.5 rounded-md ${
                isSuper
                  ? 'bg-primary-navy text-sailcloth border border-accent-brass'
                  : 'bg-deep-charcoal/10 text-deep-charcoal'
              }`}
            >
              {operator.role.replace('_', ' ')}
            </span>
          </div>
        )}
        <p className="font-body text-deep-charcoal mb-4">
          The Operator Console is loading. Use the sidebar to navigate.
        </p>
        <p className="font-body text-sm text-deep-charcoal">
          Need help? See the sidebar for available sections.
        </p>
      </div>
    </section>
  );
}
