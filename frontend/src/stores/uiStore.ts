// Authorized by HUB-1577 — UI store (Zustand) for the Operator Console shell.
// Per R1 comment 14527: collapsed/expanded sidebar state lives here (separate from session
// store). Downstream Epics (E-FE-2 dashboard widgets, E-FE-3 product detail) read this
// to adjust their own grid layouts when the sidebar is collapsed.
import { create } from 'zustand';

export interface UIState {
  /** User-toggled preference for the sidebar (collapsed=true). Viewport-driven auto-collapse
   * at 1024-1280px is handled by CSS responsive classes (Sidebar.tsx); this flag is the
   * user-override surface for >1280px desktop. */
  sidebarCollapsed: boolean;
}

export interface UIActions {
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export type UIStore = UIState & UIActions;

const INITIAL_STATE: UIState = {
  sidebarCollapsed: false,
};

export const useUIStore = create<UIStore>((set) => ({
  ...INITIAL_STATE,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));

export const useSidebarCollapsed = (): boolean =>
  useUIStore((s) => s.sidebarCollapsed);
