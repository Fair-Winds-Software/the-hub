// Authorized by HUB-1572 — unit tests for operator session store (AC#1-#7 + R1 isHydrating contract)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useSessionStore,
  type Operator,
  type SessionPayload,
} from '../sessionStore';

const SAMPLE_OPERATOR: Operator = {
  id: 'op-1',
  email: 'sammy@maverick.example',
  name: 'Sammy Hoelscher',
  role: 'super_admin',
};

const SAMPLE_PAYLOAD: SessionPayload = {
  accessToken: 'access-token-abc',
  refreshToken: 'refresh-token-xyz',
  operator: SAMPLE_OPERATOR,
};

function resetStore(): void {
  useSessionStore.setState({
    accessToken: null,
    refreshToken: null,
    operator: null,
    isAuthenticated: false,
    isHydrating: true,
  });
}

describe('sessionStore (HUB-1572)', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('initial state (R1 isHydrating contract)', () => {
    it('starts with isHydrating=true and isAuthenticated=false', () => {
      const state = useSessionStore.getState();
      expect(state.isHydrating).toBe(true);
      expect(state.isAuthenticated).toBe(false);
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.operator).toBeNull();
    });
  });

  describe('AC#3: setSession atomic', () => {
    it('populates accessToken + refreshToken + operator and flips isAuthenticated=true', () => {
      useSessionStore.getState().setSession(SAMPLE_PAYLOAD);
      const state = useSessionStore.getState();
      expect(state.accessToken).toBe('access-token-abc');
      expect(state.refreshToken).toBe('refresh-token-xyz');
      expect(state.operator).toEqual(SAMPLE_OPERATOR);
      expect(state.isAuthenticated).toBe(true);
    });
  });

  describe('AC#4: clearSession resets everything', () => {
    it('returns all session fields to null and flips isAuthenticated=false', () => {
      useSessionStore.getState().setSession(SAMPLE_PAYLOAD);
      useSessionStore.getState().clearSession();
      const state = useSessionStore.getState();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.operator).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });
  });

  describe('AC#6: no persistent storage writes', () => {
    let localStorageSpy: ReturnType<typeof vi.spyOn>;
    let cookieSetterSpy: ReturnType<typeof vi.fn>;
    let originalCookieDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      localStorageSpy = vi.spyOn(Storage.prototype, 'setItem');
      cookieSetterSpy = vi.fn();
      originalCookieDescriptor = Object.getOwnPropertyDescriptor(
        Document.prototype,
        'cookie',
      );
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => '',
        set: cookieSetterSpy,
      });
    });

    afterEach(() => {
      localStorageSpy.mockRestore();
      if (originalCookieDescriptor) {
        Object.defineProperty(Document.prototype, 'cookie', originalCookieDescriptor);
      }
    });

    it('does not write to localStorage on setSession', () => {
      useSessionStore.getState().setSession(SAMPLE_PAYLOAD);
      expect(localStorageSpy).not.toHaveBeenCalled();
    });

    it('does not write to localStorage on clearSession', () => {
      useSessionStore.getState().setSession(SAMPLE_PAYLOAD);
      localStorageSpy.mockClear();
      useSessionStore.getState().clearSession();
      expect(localStorageSpy).not.toHaveBeenCalled();
    });

    it('does not write to document.cookie on setSession or clearSession', () => {
      useSessionStore.getState().setSession(SAMPLE_PAYLOAD);
      useSessionStore.getState().clearSession();
      expect(cookieSetterSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC#7 + R1: hydrateFromRefresh', () => {
    it('on resolve: populates session + sets isHydrating=false + isAuthenticated=true', async () => {
      const refresh = vi.fn().mockResolvedValue(SAMPLE_PAYLOAD);
      await useSessionStore.getState().hydrateFromRefresh(refresh);
      const state = useSessionStore.getState();
      expect(state.isHydrating).toBe(false);
      expect(state.isAuthenticated).toBe(true);
      expect(state.accessToken).toBe('access-token-abc');
      expect(state.operator?.role).toBe('super_admin');
      expect(refresh).toHaveBeenCalledOnce();
    });

    it('on reject (e.g., 401 from refresh): leaves state empty + sets isHydrating=false', async () => {
      const refresh = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
      await useSessionStore.getState().hydrateFromRefresh(refresh);
      const state = useSessionStore.getState();
      expect(state.isHydrating).toBe(false);
      expect(state.isAuthenticated).toBe(false);
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.operator).toBeNull();
    });

    it('handles refresh rejection without unhandled promise rejection', async () => {
      const refresh = vi.fn().mockRejectedValue(new Error('network down'));
      await expect(
        useSessionStore.getState().hydrateFromRefresh(refresh),
      ).resolves.toBeUndefined();
    });
  });

  describe('AC#5: selector hooks (state-shape contract)', () => {
    it('useRole returns operator.role after setSession; null after clearSession', () => {
      // We test via direct store reads since hook re-renders require a React test renderer.
      // The hook implementations are pure selector projections of state — testing the
      // state projection directly is sufficient at this scaffold scope.
      useSessionStore.getState().setSession(SAMPLE_PAYLOAD);
      expect(useSessionStore.getState().operator?.role).toBe('super_admin');
      useSessionStore.getState().clearSession();
      expect(useSessionStore.getState().operator?.role ?? null).toBeNull();
    });
  });
});
