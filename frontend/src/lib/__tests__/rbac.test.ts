// Authorized by HUB-1574 — useRBACGuard hook tests (covers ACs #1, #2, #5, #6)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRBACGuard, ROLE_HIERARCHY } from '../rbac';
import { useSessionStore, type Operator } from '../../stores/sessionStore';

const SUPER: Operator = { id: 'op-super', email: 's@x', name: 'Super', role: 'super_admin' };
const PRODUCT: Operator = { id: 'op-pa', email: 'p@x', name: 'Prod', role: 'product_admin' };

function setRole(operator: Operator | null): void {
  useSessionStore.setState({
    accessToken: operator ? 'token' : null,
    refreshToken: operator ? 'refresh' : null,
    operator,
    isAuthenticated: operator !== null,
    isHydrating: false,
  });
}

describe('useRBACGuard (HUB-1574)', () => {
  beforeEach(() => {
    setRole(null);
  });

  afterEach(() => {
    setRole(null);
  });

  describe('AC#2: role hierarchy matrix', () => {
    it('super_admin → allowed on super_admin route', () => {
      setRole(SUPER);
      const { result } = renderHook(() => useRBACGuard('super_admin'));
      expect(result.current).toEqual({ allowed: true, role: 'super_admin' });
    });

    it('super_admin → allowed on product_admin route', () => {
      setRole(SUPER);
      const { result } = renderHook(() => useRBACGuard('product_admin'));
      expect(result.current).toEqual({ allowed: true, role: 'super_admin' });
    });

    it('product_admin → DENIED on super_admin route', () => {
      setRole(PRODUCT);
      const { result } = renderHook(() => useRBACGuard('super_admin'));
      expect(result.current).toEqual({ allowed: false, role: 'product_admin' });
    });

    it('product_admin → allowed on product_admin route', () => {
      setRole(PRODUCT);
      const { result } = renderHook(() => useRBACGuard('product_admin'));
      expect(result.current).toEqual({ allowed: true, role: 'product_admin' });
    });

    it('null (unauthenticated) → DENIED on every route', () => {
      setRole(null);
      const superResult = renderHook(() => useRBACGuard('super_admin')).result;
      const productResult = renderHook(() => useRBACGuard('product_admin')).result;
      expect(superResult.current).toEqual({ allowed: false, role: null });
      expect(productResult.current).toEqual({ allowed: false, role: null });
    });
  });

  describe('AC#5: re-renders on session store mutation (no stale closure)', () => {
    it('flips allowed=true → false when clearSession is called', () => {
      setRole(SUPER);
      const { result, rerender } = renderHook(() => useRBACGuard('super_admin'));
      expect(result.current.allowed).toBe(true);

      // Mid-life session clear.
      useSessionStore.getState().clearSession();
      rerender();
      expect(result.current.allowed).toBe(false);
      expect(result.current.role).toBeNull();
    });
  });

  describe('ROLE_HIERARCHY contract', () => {
    it('super_admin includes both roles; product_admin includes only itself', () => {
      expect(ROLE_HIERARCHY.super_admin).toEqual(['super_admin', 'product_admin']);
      expect(ROLE_HIERARCHY.product_admin).toEqual(['product_admin']);
    });
  });
});
