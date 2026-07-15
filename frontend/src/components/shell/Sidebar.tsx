// Authorized by HUB-1577 — Sidebar for the Console Shell (S8 ACs #3, #4).
// Authorized by HUB-1578 — Per-item RBAC filter via useRBACGuard (S9 AC#1).
// Vertical list of nav items; active item highlight; viewport-responsive auto-collapse
// at 1024-1280px (Tailwind xl breakpoint); user toggle via uiStore (Zustand).
// Items the operator cannot access are filtered OUT entirely (no greyed-out state per AC#1).
import { Link, useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSidebarCollapsed, useUIStore } from '../../stores/uiStore';
import { NAV_ITEMS, type NavItem } from '../../config/navItems';
import { useRBACGuard } from '../../lib/rbac';

/** Hook that returns the subset of NAV_ITEMS the current operator can access. */
function useVisibleNavItems(): readonly NavItem[] {
  // Each item maps to a useRBACGuard call. React's rules-of-hooks require a stable hook
  // call order — NAV_ITEMS is a module-level constant so the order is stable across renders.
  return NAV_ITEMS.filter((item) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useRBACGuard(item.requiredRole).allowed,
  );
}

export function Sidebar(): React.ReactElement {
  const location = useLocation();
  const userCollapsed = useSidebarCollapsed();
  const toggle = useUIStore((s) => s.toggleSidebar);
  const visibleItems = useVisibleNavItems();

  // CSS-driven responsive: collapsed by default below xl (1280px); user toggle above xl.
  // Combined width: 64px for icon-rail; 240px for expanded.
  // We expose both classes; xl: prefix means "above 1280px = user preference".
  const widthClass = userCollapsed
    ? 'w-16 xl:w-16' // user-collapsed: stays collapsed across breakpoints
    : 'w-16 xl:w-60'; // default: icon-rail below xl, expanded above
  const showLabelsClass = userCollapsed
    ? 'hidden xl:hidden'
    : 'hidden xl:inline';

  return (
    <nav
      aria-label="Primary"
      className={`flex flex-col bg-primary-navy/95 text-sailcloth motion-reduce:transition-none transition-[width] duration-200 ${widthClass}`}
      data-testid="sidebar"
      data-user-collapsed={userCollapsed}
    >
      <ul className="flex-1 py-2">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.route;
          return (
            <li key={item.id}>
              <Link
                to={item.route}
                aria-current={isActive ? 'page' : undefined}
                data-testid={`nav-${item.id}`}
                className={`flex items-center gap-3 px-4 py-2 mx-2 my-0.5 rounded-md font-body text-sm motion-reduce:transition-none transition-colors duration-100 hover:bg-sailcloth/10 focus:outline-none focus:ring-2 focus:ring-sailcloth ${
                  isActive
                    ? 'bg-sailcloth/15 border-l-4 border-accent-brass'
                    : 'border-l-4 border-transparent'
                }`}
              >
                <Icon size={20} aria-hidden={true} />
                <span className={showLabelsClass}>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={toggle}
        aria-label={userCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="hidden xl:flex items-center justify-center p-3 border-t border-sailcloth/10 hover:bg-sailcloth/10 focus:outline-none focus:ring-2 focus:ring-sailcloth"
      >
        {userCollapsed ? (
          <ChevronRight size={18} aria-hidden="true" />
        ) : (
          <ChevronLeft size={18} aria-hidden="true" />
        )}
      </button>
    </nav>
  );
}
