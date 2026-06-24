// Authorized by HUB-1574 — RBACRoute wrapper (S5 of HUB-1555)
// Order of checks (R1 cascade from HUB-1572 comment 14524):
//   1. If sessionStore.isHydrating === true → render hydration placeholder
//      (NEVER redirect during hydration — otherwise refresh-on-mount races
//      against the guard and bounces operators to login on every reload).
//   2. If role === null → redirect to /console/login with state.from (AC#4).
//   3. If not allowed for requiredRole → render `fallback`
//      (default: redirect to /console/dashboard) (AC#3).
//   4. Else render children.
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useIsHydrating } from '../stores/sessionStore';
import { useRBACGuard } from '../lib/rbac';
import type { OperatorRole } from '../stores/sessionStore';

export interface RBACRouteProps {
  requiredRole: OperatorRole;
  /** Override the default deny-fallback. Defaults to <Navigate to="/console/dashboard" replace />. */
  fallback?: ReactNode;
  /**
   * Optional callback fired when access is denied (allowed=false but role!==null).
   * v0.1 toast system isn't built yet; HUB-1577 will pass a toast-firing callback.
   */
  onDenied?: (deniedReason: 'unauthenticated' | 'insufficient_role') => void;
  children: ReactNode;
}

function HydrationPlaceholder(): ReactNode {
  return <div aria-live="polite">Loading session&hellip;</div>;
}

export function RBACRoute({
  requiredRole,
  fallback,
  onDenied,
  children,
}: RBACRouteProps): ReactNode {
  const isHydrating = useIsHydrating();
  const { allowed, role } = useRBACGuard(requiredRole);
  const location = useLocation();

  if (isHydrating) {
    return <HydrationPlaceholder />;
  }

  if (role === null) {
    onDenied?.('unauthenticated');
    return (
      <Navigate
        to="/console/login"
        state={{ from: location.pathname + location.search }}
        replace
      />
    );
  }

  if (!allowed) {
    onDenied?.('insufficient_role');
    return fallback ?? <Navigate to="/console/dashboard" replace />;
  }

  return children;
}
