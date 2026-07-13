// Authorized by HUB-1577 — nav items config (icon + label + route + RBAC) for the Console Sidebar.
// Downstream Epics will append items (Products, Audit, Plan Advisor, etc.) as they ship; this
// v0.1 list is intentionally minimal: dashboard is real (HUB-1644 Dashboard shell — replaced
// the HUB-1577/1694 DashboardStub), audit/settings are placeholders the sidebar filter in
// HUB-1578 will RBAC-gate.
// HUB-1795 (S6 of HUB-1783) — Connections admin panel entry added; super_admin gated
// because the mode toggle mutates HUB↔external state (Stripe mode = billing-plane
// consequence). Icon is `Plug` from lucide.
// HUB-1799 (S3 of HUB-1784) — Mock Data admin panel entry added; super_admin gated
// because seed/wipe operations mutate the mock store (mock-only guard on backend).
// Icon is `Database` from lucide.
import { Database, LayoutDashboard, Plug, ScrollText, Settings, type LucideIcon } from 'lucide-react';
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
    id: 'connections',
    label: 'Connections',
    route: '/console/connections',
    requiredRole: 'super_admin',
    icon: Plug,
  },
  {
    id: 'mock-data',
    label: 'Mock Data',
    route: '/console/mock-data',
    requiredRole: 'super_admin',
    icon: Database,
  },
  {
    id: 'settings',
    label: 'Settings',
    route: '/console/settings',
    requiredRole: 'super_admin',
    icon: Settings,
  },
] as const;
