// Authorized by HUB-1577 — nav items config (icon + label + route + RBAC) for the Console Sidebar.
// Downstream Epics will append items (Products, Audit, Plan Advisor, etc.) as they ship; this
// v0.1 list is intentionally minimal: dashboard is real (DashboardStub), audit/settings are
// placeholders the sidebar filter in HUB-1578 will RBAC-gate.
import { LayoutDashboard, ScrollText, Settings, type LucideIcon } from 'lucide-react';
import type { OperatorRole } from '../stores/sessionStore';

export interface NavItem {
  /** Stable identifier used by tests + analytics. */
  id: string;
  label: string;
  /** Absolute route path. */
  route: string;
  /** Minimum role required to see this nav item. */
  requiredRole: OperatorRole;
  /** Lucide icon component (rendered at 20px in expanded view, 24px in icon-rail). */
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    route: '/console/dashboard',
    requiredRole: 'product_admin',
    icon: LayoutDashboard,
  },
  {
    id: 'audit',
    label: 'Audit Log',
    route: '/console/audit',
    requiredRole: 'super_admin',
    icon: ScrollText,
  },
  {
    id: 'settings',
    label: 'Settings',
    route: '/console/settings',
    requiredRole: 'super_admin',
    icon: Settings,
  },
] as const;
