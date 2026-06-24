// Authorized by HUB-1577 — Sidebar for the Console Shell (S8 ACs #3, #4).
// Vertical list of nav items; active item highlight; viewport-responsive auto-collapse
// at 1024-1280px (Tailwind xl breakpoint); user toggle via uiStore (Zustand).
// HUB-1578 (S9) wires the per-item RBAC filter — for now we render all items; HUB-1574
// useRBACGuard is the gate at the route level.
import { useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSidebarCollapsed, useUIStore } from '../../stores/uiStore';
import { NAV_ITEMS } from '../../config/navItems';

export function Sidebar(): React.ReactElement {
  const location = useLocation();
  const userCollapsed = useSidebarCollapsed();
  const toggle = useUIStore((s) => s.toggleSidebar);

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
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.route;
          return (
            <li key={item.id}>
              <a
                href={item.route}
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
              </a>
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
