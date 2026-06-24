// Authorized by HUB-1574 — RBAC primitive (S5 of HUB-1555)
//
// INVARIANT: Server-side RBAC is authoritative.
// Client-side guards exposed here are a UX layer ONLY:
//   - They hide nav items the operator can't reach (sidebar filter in HUB-1578).
//   - They redirect URL-hack attempts away from forbidden routes.
//   - They are NOT a security boundary — every server endpoint MUST enforce
//     its own RBAC and return 403 to clients that bypass these guards.
// Documented for Stage 4 /redteam review.
//
// Role hierarchy (R1-locked, D-HUB-SCOPE-035 single-tenant model):
//   super_admin  → allowed for: super_admin, product_admin
//   product_admin → allowed for: product_admin
//   null         → allowed for: nothing (renders login redirect upstream)
import { useRole, type OperatorRole } from '../stores/sessionStore';

/**
 * Inclusion matrix: given the operator's actual role, which `requiredRole`
 * values are permitted? `super_admin` includes all v0.1 roles; `product_admin`
 * includes only itself; `null` (unauthenticated) includes nothing.
 */
export const ROLE_HIERARCHY: Record<OperatorRole, readonly OperatorRole[]> = {
  super_admin: ['super_admin', 'product_admin'],
  product_admin: ['product_admin'],
} as const;

export interface RBACGuardResult {
  /** True iff the current operator's role satisfies `requiredRole`. */
  allowed: boolean;
  /** The operator's current role (null if unauthenticated). */
  role: OperatorRole | null;
}

/**
 * Returns `{allowed, role}` for the operator's current session against the
 * `requiredRole` parameter. Read-only — no side effects, no useEffect.
 *
 * Re-renders on every session-store mutation (Zustand selector dependency)
 * so consumers do NOT need to memoize the result manually.
 */
export function useRBACGuard(requiredRole: OperatorRole): RBACGuardResult {
  const role = useRole();
  if (role === null) {
    return { allowed: false, role: null };
  }
  const allowed = ROLE_HIERARCHY[role].includes(requiredRole);
  return { allowed, role };
}
