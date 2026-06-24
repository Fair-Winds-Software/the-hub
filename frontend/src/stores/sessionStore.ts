// Authorized by HUB-1572 — Operator session store (Zustand, in-memory only)
// R1 amendment (comment 14537): adds isHydrating: boolean to prevent guard-redirect race
// during refresh-on-mount. Initial state: isHydrating=true, isAuthenticated=false.
// AC#6: no localStorage / sessionStorage / cookie writes anywhere in this module.
// HUB-1573 will wire apiClient.refresh into hydrateFromRefresh; this store accepts the
// refresh function as a parameter (dependency injection) — no HTTP imports.
import { create } from 'zustand';

export type OperatorRole = 'super_admin' | 'product_admin';

export interface Operator {
  id: string;
  email: string;
  name: string;
  role: OperatorRole;
}

export interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  operator: Operator;
}

export interface SessionState {
  accessToken: string | null;
  refreshToken: string | null;
  operator: Operator | null;
  isAuthenticated: boolean;
  isHydrating: boolean;
}

export interface SessionActions {
  setSession: (payload: SessionPayload) => void;
  clearSession: () => void;
  /**
   * Bootstrap-time hydration. Consumer (HUB-1573 apiClient init or App useEffect)
   * passes a refresh function that resolves to a SessionPayload on success and rejects
   * on 401 (or any error). The store updates state + clears isHydrating on resolve OR reject.
   */
  hydrateFromRefresh: (refresh: () => Promise<SessionPayload>) => Promise<void>;
}

export type SessionStore = SessionState & SessionActions;

const INITIAL_STATE: SessionState = {
  accessToken: null,
  refreshToken: null,
  operator: null,
  isAuthenticated: false,
  isHydrating: true,
};

export const useSessionStore = create<SessionStore>((set) => ({
  ...INITIAL_STATE,

  setSession: ({ accessToken, refreshToken, operator }) => {
    set({
      accessToken,
      refreshToken,
      operator,
      isAuthenticated: true,
    });
  },

  clearSession: () => {
    set({
      accessToken: null,
      refreshToken: null,
      operator: null,
      isAuthenticated: false,
    });
  },

  hydrateFromRefresh: async (refresh) => {
    try {
      const payload = await refresh();
      set({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        operator: payload.operator,
        isAuthenticated: true,
        isHydrating: false,
      });
    } catch {
      set({
        accessToken: null,
        refreshToken: null,
        operator: null,
        isAuthenticated: false,
        isHydrating: false,
      });
    }
  },
}));

// Selector hooks (AC#5). Each hook returns a single slice for re-render optimization.
export const useSession = (): SessionState =>
  useSessionStore((s) => ({
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    operator: s.operator,
    isAuthenticated: s.isAuthenticated,
    isHydrating: s.isHydrating,
  }));

export const useOperator = (): Operator | null => useSessionStore((s) => s.operator);

export const useRole = (): OperatorRole | null => useSessionStore((s) => s.operator?.role ?? null);

export const useAccessToken = (): string | null => useSessionStore((s) => s.accessToken);

export const useIsHydrating = (): boolean => useSessionStore((s) => s.isHydrating);

// Authorized by HUB-1576 — granular selector hook for already-authenticated mount-time check.
// Prefer this over useSession() when only the boolean is needed (avoids whole-object re-renders).
export const useIsAuthenticated = (): boolean => useSessionStore((s) => s.isAuthenticated);
