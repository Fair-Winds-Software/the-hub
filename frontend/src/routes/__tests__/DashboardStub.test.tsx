// Authorized by HUB-1694 — DashboardStub welcome-card content + a11y assertions.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import DashboardStub from '../DashboardStub';
import { useSessionStore, type Operator } from '../../stores/sessionStore';

const SUPER: Operator = {
  id: 'op-1',
  email: 's@maverick.example',
  name: 'Sammy H.',
  role: 'super_admin',
};

const PRODUCT: Operator = {
  id: 'op-2',
  email: 'w@maverick.example',
  name: 'Wayne S.',
  role: 'product_admin',
};

function seedOperator(operator: Operator | null): void {
  useSessionStore.setState({
    accessToken: operator ? 'at' : null,
    refreshToken: operator ? 'rt' : null,
    operator,
    isAuthenticated: operator !== null,
    isHydrating: false,
  });
}

function renderStubAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/console/dashboard" element={<DashboardStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DashboardStub (HUB-1694)', () => {
  beforeEach(() => {
    seedOperator(SUPER);
  });

  afterEach(() => {
    seedOperator(null);
  });

  describe('AC#1: welcome card content', () => {
    it('renders "Welcome to HUB" heading', () => {
      renderStubAt('/console/dashboard');
      expect(screen.getByRole('heading', { name: /welcome to hub/i })).toBeInTheDocument();
    });

    it('renders operator email from the session store', () => {
      renderStubAt('/console/dashboard');
      expect(screen.getByTestId('stub-operator-email')).toHaveTextContent('s@maverick.example');
    });

    it('renders the role badge with super_admin styling', () => {
      renderStubAt('/console/dashboard');
      const badge = screen.getByTestId('stub-role-badge');
      expect(badge).toHaveTextContent(/super admin/i);
      expect(badge).toHaveAttribute('aria-label', 'Role: super_admin');
    });

    it('renders the role badge with product_admin styling', () => {
      seedOperator(PRODUCT);
      renderStubAt('/console/dashboard');
      const badge = screen.getByTestId('stub-role-badge');
      expect(badge).toHaveTextContent(/product admin/i);
      expect(badge).toHaveAttribute('aria-label', 'Role: product_admin');
    });

    it('renders the sidebar nudge body text + help line', () => {
      renderStubAt('/console/dashboard');
      expect(
        screen.getByText(/operator console is loading\. use the sidebar to navigate/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/need help\? see the sidebar for available sections/i),
      ).toBeInTheDocument();
    });

    it('hides operator-specific content when no operator is in session', () => {
      seedOperator(null);
      renderStubAt('/console/dashboard');
      expect(screen.queryByTestId('stub-operator-email')).toBeNull();
      expect(screen.queryByTestId('stub-role-badge')).toBeNull();
      // Welcome heading + body still render — the stub still serves the post-redirect screen.
      expect(screen.getByRole('heading', { name: /welcome to hub/i })).toBeInTheDocument();
    });
  });

  describe('AC#3: a11y landmark + axe', () => {
    it('exposes a region landmark labeled "Dashboard placeholder"', () => {
      renderStubAt('/console/dashboard');
      expect(
        screen.getByRole('region', { name: /dashboard placeholder/i }),
      ).toBeInTheDocument();
    });

    it('renders with zero axe-core violations', async () => {
      const { container } = renderStubAt('/console/dashboard');
      const results = await axe(container);
      expect(results.violations).toHaveLength(0);
    });
  });
});
