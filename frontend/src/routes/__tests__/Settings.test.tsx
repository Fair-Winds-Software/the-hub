// Authorized by HUB-1662 (E-FE-6 S3) — Settings shell smoke test. Covers
// sidebar landmark + 5 nav entries, default redirect from /console/settings
// to /console/settings/operators, deep-link into each sub-route, active-
// state highlight via aria-current, and axe zero violations.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import Settings, { SETTINGS_SECTIONS } from '../Settings';
import { SettingsPlaceholder } from '../settings/SettingsPlaceholder';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/console/settings" element={<Settings />}>
          <Route
            index
            element={<Navigate to="/console/settings/operators" replace />}
          />
          <Route
            path="operators"
            element={
              <SettingsPlaceholder
                sectionLabel="Operators"
                sectionId="operators"
                storyKey="HUB-1663"
              />
            }
          />
          <Route
            path="hub"
            element={
              <SettingsPlaceholder
                sectionLabel="HUB Settings"
                sectionId="hub"
                storyKey="HUB-1664"
              />
            }
          />
          <Route
            path="notifications"
            element={
              <SettingsPlaceholder
                sectionLabel="Notifications"
                sectionId="notifications"
                storyKey="HUB-1665"
              />
            }
          />
          <Route
            path="escalation"
            element={
              <SettingsPlaceholder
                sectionLabel="Escalation"
                sectionId="escalation"
                storyKey="HUB-1666"
              />
            }
          />
          <Route
            path="hooks"
            element={
              <SettingsPlaceholder
                sectionLabel="Workflow Hooks"
                sectionId="hooks"
                storyKey="HUB-1667"
              />
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('Settings shell (HUB-1662)', () => {
  it('renders the sidebar landmark with all five nav entries', () => {
    renderAt('/console/settings/operators');
    expect(screen.getByTestId('settings-sidebar')).toBeInTheDocument();
    for (const s of SETTINGS_SECTIONS) {
      expect(
        screen.getByTestId(`settings-nav-${s.id}`),
      ).toBeInTheDocument();
    }
  });

  it('index route redirects to /console/settings/operators', () => {
    renderAt('/console/settings');
    expect(
      screen.getByTestId('settings-placeholder-operators'),
    ).toBeInTheDocument();
  });

  it.each(SETTINGS_SECTIONS.map((s) => [s.id, s.route]))(
    'deep-link to %s sub-route mounts the matching placeholder',
    (id, route) => {
      renderAt(route);
      expect(
        screen.getByTestId(`settings-placeholder-${id}`),
      ).toBeInTheDocument();
    },
  );

  it('active sub-route nav item is aria-current via NavLink', () => {
    renderAt('/console/settings/notifications');
    const active = screen.getByTestId('settings-nav-notifications');
    expect(active.getAttribute('aria-current')).toBe('page');
  });

  it('placeholder body mentions the owner story key so operators know where to look', () => {
    renderAt('/console/settings/hooks');
    const placeholder = screen.getByTestId('settings-placeholder-hooks');
    expect(placeholder.textContent).toMatch(/HUB-1667/);
  });

  it('passes axe scan in the operators default state', async () => {
    const { container } = renderAt('/console/settings/operators');
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
