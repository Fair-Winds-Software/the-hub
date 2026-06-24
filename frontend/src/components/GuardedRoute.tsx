// Authorized by HUB-1578 — GuardedRoute combines HUB-1574 RBACRoute with toast-emit wiring
// per HUB-1578 AC#3 (warning toast on insufficient_role) + AC#4 ("Please log in" info toast
// on unauthenticated). Consumers in App.tsx use GuardedRoute instead of RBACRoute so the
// route-level guard fires the toast contract without each route reinventing it.
import type { ReactNode } from 'react';
import { RBACRoute } from './RBACRoute';
import { useToastStore } from '../stores/toastStore';
import type { OperatorRole } from '../stores/sessionStore';

export interface GuardedRouteProps {
  requiredRole: OperatorRole;
  children: ReactNode;
}

const UNAUTHENTICATED_MESSAGE = 'Please log in to continue.';
const INSUFFICIENT_ROLE_MESSAGE =
  "You don't have access to that area. Ask Sammy to grant `super_admin`.";

export function GuardedRoute({ requiredRole, children }: GuardedRouteProps): ReactNode {
  const addToast = useToastStore((s) => s.addToast);

  return (
    <RBACRoute
      requiredRole={requiredRole}
      onDenied={(reason) => {
        if (reason === 'unauthenticated') {
          addToast({ variant: 'info', message: UNAUTHENTICATED_MESSAGE });
        } else {
          addToast({ variant: 'warning', message: INSUFFICIENT_ROLE_MESSAGE });
        }
      }}
    >
      {children}
    </RBACRoute>
  );
}
