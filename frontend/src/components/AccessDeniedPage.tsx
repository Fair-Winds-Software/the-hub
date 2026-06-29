// Authorized by HUB-1609 (E-FE-3 S9) — full-page denial UX rendered when a
// server-side RBAC check returns 403. Distinct from a 404: this is "you can't
// see this", not "this doesn't exist." Operators get an explicit instruction
// to ask Sammy to grant access plus a back link to the upstream listing.
//
// Focus management: focus moves to the back-link on mount so SR users hear the
// denial announcement first (via role=alert) and have a keyboard target one
// Tab away.
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

export interface AccessDeniedPageProps {
  /** Human-readable resource name shown in the headline ("this product", "this customer", etc.). */
  resourceLabel: string;
  /** Where the back link points. */
  backTo: string;
  /** Copy for the back link. Defaults to "Back". */
  backLabel?: string;
}

export function AccessDeniedPage({
  resourceLabel,
  backTo,
  backLabel = 'Back',
}: AccessDeniedPageProps): React.ReactElement {
  const backLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    backLinkRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      data-testid="access-denied-page"
      className="rounded-md border border-ironwake/40 bg-ironwake/5 p-6 text-sm font-body text-ironwake"
    >
      <h1
        data-testid="access-denied-heading"
        className="font-heading text-xl text-ironwake mb-2"
      >
        You don&apos;t have access to {resourceLabel}.
      </h1>
      <p className="mb-4">
        Your operator role doesn&apos;t include this resource in scope. Ask Sammy
        to grant <code>super_admin</code> or add this resource to your
        product scope.
      </p>
      <Link
        to={backTo}
        ref={backLinkRef}
        data-testid="access-denied-back-link"
        className="inline-block underline focus:outline-none focus:ring-2 focus:ring-accent-brass"
      >
        {backLabel}
      </Link>
    </div>
  );
}
