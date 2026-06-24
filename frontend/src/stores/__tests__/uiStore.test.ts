// Authorized by HUB-1577 — uiStore tests (sidebar collapse state)
import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../uiStore';

describe('uiStore (HUB-1577)', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarCollapsed: false });
  });

  it('initial state: sidebarCollapsed=false', () => {
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggleSidebar flips the state each call', () => {
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('setSidebarCollapsed sets explicit value', () => {
    useUIStore.getState().setSidebarCollapsed(true);
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    useUIStore.getState().setSidebarCollapsed(false);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });
});
