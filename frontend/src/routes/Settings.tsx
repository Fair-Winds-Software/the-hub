// Authorized by HUB-1662 (E-FE-6 S3) — Settings shell + sidebar nav +
// sub-route slot. Renders a two-column layout: a fixed-width left rail
// listing all five settings sections + a right content region driven by
// the sub-routes registered in App.tsx.
//
// Sub-routes are independently deep-linkable per the story spec so operators
// can share URLs like /console/settings/operators directly. Sub-routes that
// haven't shipped yet render an Ironclad 'Coming soon' placeholder via
// SettingsPlaceholder — S4..S8 will each swap the placeholder for the real
// component in a single App.tsx edit without touching this shell.
//
// Mobile responsive baseline (Tailwind): the left rail collapses to a
// scrollable horizontal tab strip at < md so the whole page stays usable
// on smaller viewports. Full drawer / dropdown UX defers to a later
// responsive-polish pass; the horizontal strip preserves keyboard tab
// order and the aria-current highlight.
import { NavLink, Outlet } from 'react-router-dom';

const PAGE_TITLE = 'Settings | HUB Console';

interface SettingsSection {
  id: string;
  label: string;
  route: string;
  hint: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'operators',
    label: 'Operators',
    route: '/console/settings/operators',
    hint: 'Manage operator accounts, roles, and last-super_admin protection.',
  },
  {
    id: 'hub',
    label: 'HUB Settings',
    route: '/console/settings/hub',
    hint: 'Well-known HUB configuration keys backed by the shared catalog.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    route: '/console/settings/notifications',
    hint: 'Notification channels and test-send controls per product.',
  },
  {
    id: 'escalation',
    label: 'Escalation',
    route: '/console/settings/escalation',
    hint: 'Escalation rules — up to two tiers per alert type.',
  },
  {
    id: 'hooks',
    label: 'Workflow Hooks',
    route: '/console/settings/hooks',
    hint: 'Outbound workflow hooks with HMAC signing + execution history.',
  },
] as const;

export default function Settings(): React.ReactElement {
  if (typeof document !== 'undefined' && document.title !== PAGE_TITLE) {
    document.title = PAGE_TITLE;
  }
  return (
    <div
      id="main-content"
      data-testid="settings-page"
      className="flex flex-col gap-4 md:flex-row md:items-start"
    >
      <nav
        aria-label="Settings sections"
        data-testid="settings-sidebar"
        className="w-full shrink-0 md:w-60"
      >
        <ul className="flex overflow-x-auto md:flex-col md:overflow-x-visible md:gap-1">
          {SETTINGS_SECTIONS.map((s) => (
            <li key={s.id} className="shrink-0 md:shrink">
              <NavLink
                to={s.route}
                data-testid={`settings-nav-${s.id}`}
                className={({ isActive }) =>
                  isActive
                    ? 'flex items-center gap-2 rounded-md border-l-2 border-primary-navy bg-primary-navy/5 px-3 py-2 text-sm font-body font-semibold text-primary-navy no-underline focus:outline-none focus:ring-2 focus:ring-accent-brass'
                    : 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-body text-deep-charcoal/70 no-underline hover:bg-deep-charcoal/5 hover:text-primary-navy focus:outline-none focus:ring-2 focus:ring-accent-brass'
                }
              >
                {s.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <section
        aria-label="Settings content"
        data-testid="settings-content"
        className="min-w-0 flex-1"
      >
        <Outlet />
      </section>
    </div>
  );
}
