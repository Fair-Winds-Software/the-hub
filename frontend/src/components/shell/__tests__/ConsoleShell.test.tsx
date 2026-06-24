// Authorized by HUB-1577 — ConsoleShell + TopNav + Sidebar + ErrorBoundary tests
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import { ConsoleShell } from '../ConsoleShell';
import { useSessionStore, type Operator } from '../../../stores/sessionStore';
import { useUIStore } from '../../../stores/uiStore';

const SUPER: Operator = {
  id: 'op-1',
  email: 's@maverick.example',
  name: 'Sammy Hoelscher',
  role: 'super_admin',
};

const PRODUCT: Operator = {
  id: 'op-2',
  email: 'w@maverick.example',
  name: 'Wayne Smith',
  role: 'product_admin',
};

const VERY_LONG: Operator = {
  id: 'op-3',
  email: 'x@maverick.example',
  name: 'Alexander Hamilton Burr-Washington',
  role: 'super_admin',
};

function setSession(operator: Operator | null, isHydrating = false): void {
  useSessionStore.setState({
    accessToken: operator ? 'token' : null,
    refreshToken: operator ? 'refresh' : null,
    operator,
    isAuthenticated: operator !== null,
    isHydrating,
  });
}

function ThrowingRoute(): React.ReactElement {
  throw new Error('boom from route');
}

function renderShellAt(path: string, children: React.ReactNode): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ConsoleShell />}>
          <Route path="/console/dashboard" element={children} />
          <Route path="/console/audit" element={<div>AUDIT</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ConsoleShell (HUB-1577)', () => {
  beforeEach(() => {
    setSession(null);
    useUIStore.setState({ sidebarCollapsed: false });
  });

  afterEach(() => {
    setSession(null);
    useUIStore.setState({ sidebarCollapsed: false });
  });

  describe('AC#1 + AC#3: shell renders TopNav + Sidebar + outlet', () => {
    it('renders top nav, sidebar nav items, and the matching outlet content', () => {
      setSession(SUPER);
      renderShellAt('/console/dashboard', <div>OUTLET CONTENT</div>);

      // Top nav.
      expect(screen.getByRole('banner')).toBeInTheDocument();
      // Sidebar.
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
      // Outlet.
      expect(screen.getByText('OUTLET CONTENT')).toBeInTheDocument();
      // Main slot.
      expect(screen.getByRole('main')).toBeInTheDocument();
      // Skip-to-content link.
      expect(screen.getByText(/Skip to content/i)).toBeInTheDocument();
    });

    it('AC#3: active nav item gets aria-current="page"', () => {
      setSession(SUPER);
      renderShellAt('/console/dashboard', <div>OUTLET</div>);
      expect(screen.getByTestId('nav-dashboard')).toHaveAttribute('aria-current', 'page');
      expect(screen.getByTestId('nav-audit')).not.toHaveAttribute('aria-current');
    });
  });

  describe('AC#2: top nav shows operator name + role badge', () => {
    it('super_admin → brass badge', () => {
      setSession(SUPER);
      renderShellAt('/console/dashboard', <div>X</div>);
      expect(screen.getByTestId('operator-name')).toHaveTextContent('Sammy Hoelscher');
      const badge = screen.getByTestId('role-badge');
      expect(badge).toHaveTextContent(/super admin/i);
      expect(badge).toHaveAttribute('aria-label', 'Role: super_admin');
    });

    it('product_admin → neutral badge', () => {
      setSession(PRODUCT);
      renderShellAt('/console/dashboard', <div>X</div>);
      const badge = screen.getByTestId('role-badge');
      expect(badge).toHaveTextContent(/product admin/i);
      expect(badge).toHaveAttribute('aria-label', 'Role: product_admin');
    });

    it('truncates very long names to "First L."', () => {
      setSession(VERY_LONG);
      renderShellAt('/console/dashboard', <div>X</div>);
      expect(screen.getByTestId('operator-name')).toHaveTextContent('Alexander B.');
    });
  });

  describe('AC#4: sidebar collapse via uiStore', () => {
    it('renders with default expanded preference (sidebarCollapsed=false)', () => {
      setSession(SUPER);
      renderShellAt('/console/dashboard', <div>X</div>);
      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-user-collapsed', 'false');
    });

    it('reflects collapsed state when uiStore.sidebarCollapsed=true', () => {
      setSession(SUPER);
      useUIStore.setState({ sidebarCollapsed: true });
      renderShellAt('/console/dashboard', <div>X</div>);
      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-user-collapsed', 'true');
    });
  });

  describe('AC#5: hydration skeleton (R1 cascade from HUB-1572)', () => {
    it('renders skeleton placeholders while isHydrating=true (NEVER outlet content)', () => {
      setSession(null, true);
      renderShellAt('/console/dashboard', <div>OUTLET SHOULD NOT APPEAR</div>);

      expect(screen.getByTestId('top-nav-skeleton')).toBeInTheDocument();
      expect(screen.getByTestId('sidebar-skeleton')).toBeInTheDocument();
      expect(screen.getByTestId('main-content-skeleton')).toBeInTheDocument();
      expect(screen.queryByText('OUTLET SHOULD NOT APPEAR')).toBeNull();
      // Real TopNav and Sidebar not rendered during hydration.
      expect(screen.queryByRole('banner')).toBeNull();
      expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    });
  });

  describe('AC#6: error boundary catches outlet errors + keeps shell rendered', () => {
    it('renders fallback in main slot; TopNav + Sidebar remain functional', () => {
      setSession(SUPER);
      renderShellAt('/console/dashboard', <ThrowingRoute />);

      expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
      // TopNav still there.
      expect(screen.getByRole('banner')).toBeInTheDocument();
      // Sidebar still there.
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
      // Error message includes the thrown error's message.
      expect(screen.getByText(/boom from route/i)).toBeInTheDocument();
    });
  });

  describe('AC#7: shell does not depend on any per-route API', () => {
    it('renders without any fetch call (shell + outlet together)', () => {
      const fetchSpy = ((globalThis as { fetch?: typeof fetch }).fetch = (() => {
        throw new Error('fetch should not be called');
      }) as unknown as typeof fetch);
      setSession(SUPER);
      renderShellAt('/console/dashboard', <div>STATIC</div>);
      expect(screen.getByText('STATIC')).toBeInTheDocument();
      // If we got here without fetch throwing, AC#7 holds.
      expect(fetchSpy).toBeDefined();
    });
  });

  describe('A11y: axe-core 0 violations', () => {
    it('rendered shell has zero violations', async () => {
      setSession(SUPER);
      const { container } = renderShellAt('/console/dashboard', <div>Content</div>);
      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });
  });
});
