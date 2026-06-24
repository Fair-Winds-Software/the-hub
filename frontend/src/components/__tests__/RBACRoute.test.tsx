// Authorized by HUB-1574 — RBACRoute component tests (covers ACs #3, #4 + R1 hydration cascade)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RBACRoute } from '../RBACRoute';
import { useSessionStore, type Operator } from '../../stores/sessionStore';

const SUPER: Operator = { id: 'op-super', email: 's@x', name: 'Super', role: 'super_admin' };
const PRODUCT: Operator = { id: 'op-pa', email: 'p@x', name: 'Prod', role: 'product_admin' };

function setSession(operator: Operator | null, isHydrating = false): void {
  useSessionStore.setState({
    accessToken: operator ? 'token' : null,
    refreshToken: operator ? 'refresh' : null,
    operator,
    isAuthenticated: operator !== null,
    isHydrating,
  });
}

function renderAt(path: string, ui: React.ReactNode): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/console/login" element={<div>LOGIN PAGE</div>} />
        <Route path="/console/dashboard" element={<div>DASHBOARD</div>} />
        <Route path="/console/guarded" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RBACRoute (HUB-1574)', () => {
  beforeEach(() => {
    setSession(null);
  });

  afterEach(() => {
    setSession(null);
  });

  describe('R1 cascade from HUB-1572: isHydrating skeleton', () => {
    it('renders hydration placeholder while isHydrating=true (never redirects)', () => {
      setSession(null, true);
      renderAt(
        '/console/guarded',
        <RBACRoute requiredRole="product_admin">
          <div>SECRET</div>
        </RBACRoute>,
      );
      expect(screen.getByText(/Loading session/i)).toBeInTheDocument();
      expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();
      expect(screen.queryByText('SECRET')).not.toBeInTheDocument();
    });
  });

  describe('AC#3: renders children when allowed', () => {
    it('super_admin sees super_admin-required content', () => {
      setSession(SUPER);
      renderAt(
        '/console/guarded',
        <RBACRoute requiredRole="super_admin">
          <div>SECRET</div>
        </RBACRoute>,
      );
      expect(screen.getByText('SECRET')).toBeInTheDocument();
    });
  });

  describe('AC#3: default fallback redirects denied operator to dashboard', () => {
    it('product_admin hitting a super_admin route is redirected to /console/dashboard', () => {
      setSession(PRODUCT);
      renderAt(
        '/console/guarded',
        <RBACRoute requiredRole="super_admin">
          <div>SECRET</div>
        </RBACRoute>,
      );
      expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
      expect(screen.queryByText('SECRET')).not.toBeInTheDocument();
    });

    it('custom fallback prop overrides the default Navigate', () => {
      setSession(PRODUCT);
      renderAt(
        '/console/guarded',
        <RBACRoute requiredRole="super_admin" fallback={<div>CUSTOM DENIED</div>}>
          <div>SECRET</div>
        </RBACRoute>,
      );
      expect(screen.getByText('CUSTOM DENIED')).toBeInTheDocument();
    });
  });

  describe('AC#4: unauthenticated redirects to /console/login with state.from', () => {
    it('null operator → redirected to login page (not dashboard)', () => {
      setSession(null);
      renderAt(
        '/console/guarded',
        <RBACRoute requiredRole="product_admin">
          <div>SECRET</div>
        </RBACRoute>,
      );
      expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument();
      expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
    });
  });

  describe('onDenied callback', () => {
    it('fires onDenied("unauthenticated") when role is null', () => {
      const onDenied = vi.fn();
      setSession(null);
      renderAt(
        '/console/guarded',
        <RBACRoute requiredRole="product_admin" onDenied={onDenied}>
          <div>SECRET</div>
        </RBACRoute>,
      );
      expect(onDenied).toHaveBeenCalledWith('unauthenticated');
    });

    it('fires onDenied("insufficient_role") when role lacks privilege', () => {
      const onDenied = vi.fn();
      setSession(PRODUCT);
      renderAt(
        '/console/guarded',
        <RBACRoute requiredRole="super_admin" onDenied={onDenied}>
          <div>SECRET</div>
        </RBACRoute>,
      );
      expect(onDenied).toHaveBeenCalledWith('insufficient_role');
    });

    it('does NOT fire onDenied when allowed', () => {
      const onDenied = vi.fn();
      setSession(SUPER);
      renderAt(
        '/console/guarded',
        <RBACRoute requiredRole="super_admin" onDenied={onDenied}>
          <div>SECRET</div>
        </RBACRoute>,
      );
      expect(onDenied).not.toHaveBeenCalled();
    });
  });
});
