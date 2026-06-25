// Authorized by HUB-1579 — TopNav Sign Out button + logout wiring tests.
// Focused on the Sign Out button + click handler. Broader shell behavior is covered
// by ConsoleShell.test.tsx (HUB-1577).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TopNav } from '../TopNav';
import { useSessionStore, type Operator } from '../../../stores/sessionStore';
import { getPendingRevokes } from '../../../lib/pendingRevokes';

const SUPER: Operator = {
  id: 'op-1',
  email: 's@maverick.example',
  name: 'Sammy Hoelscher',
  role: 'super_admin',
};

function seedSession(refreshToken: string | null = 'rt-test'): void {
  useSessionStore.setState({
    accessToken: 'at-1',
    refreshToken,
    operator: SUPER,
    isAuthenticated: refreshToken !== null,
    isHydrating: false,
  });
}

function renderTopNavAt(initialPath: string): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/console/dashboard" element={<TopNav />} />
        <Route path="/console/login" element={<div data-testid="login-target">LOGIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TopNav Sign Out button (HUB-1579)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    useSessionStore.setState({
      accessToken: null,
      refreshToken: null,
      operator: null,
      isAuthenticated: false,
      isHydrating: false,
    });
    window.sessionStorage.clear();
  });

  it('renders the Sign Out button when an operator is signed in', () => {
    seedSession();
    renderTopNavAt('/console/dashboard');
    const btn = screen.getByTestId('logout-button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label', 'Sign Out');
  });

  it('does NOT render the Sign Out button when no operator is in session', () => {
    // No seed — session is initial empty state.
    useSessionStore.setState({
      accessToken: null,
      refreshToken: null,
      operator: null,
      isAuthenticated: false,
      isHydrating: false,
    });
    renderTopNavAt('/console/dashboard');
    expect(screen.queryByTestId('logout-button')).toBeNull();
  });

  it('clears the session store immediately on click', () => {
    seedSession();
    renderTopNavAt('/console/dashboard');
    act(() => {
      fireEvent.click(screen.getByTestId('logout-button'));
    });
    const state = useSessionStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.operator).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('navigates to /console/login on click', () => {
    seedSession();
    renderTopNavAt('/console/dashboard');
    act(() => {
      fireEvent.click(screen.getByTestId('logout-button'));
    });
    expect(screen.getByTestId('login-target')).toBeInTheDocument();
  });

  it('fires POST /api/v1/admin/auth/logout in the background', async () => {
    seedSession('rt-bg-call');
    renderTopNavAt('/console/dashboard');
    act(() => {
      fireEvent.click(screen.getByTestId('logout-button'));
    });
    // Background fetch is queued — flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/admin/auth/logout');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.refreshToken).toBe('rt-bg-call');
  });

  it('enqueues for retry when the background BE call fails', async () => {
    seedSession('rt-will-fail');
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    renderTopNavAt('/console/dashboard');
    act(() => {
      fireEvent.click(screen.getByTestId('logout-button'));
    });
    // Let the rejected promise chain settle.
    await new Promise((r) => setTimeout(r, 0));
    const queue = getPendingRevokes();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.refreshToken).toBe('rt-will-fail');
  });

  it('truncates very long operator names to "First L."', () => {
    useSessionStore.setState({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      operator: {
        id: 'op-2',
        email: 'x@maverick.example',
        name: 'Alexander Hamilton Burr-Washington',
        role: 'super_admin',
      },
      isAuthenticated: true,
      isHydrating: false,
    });
    renderTopNavAt('/console/dashboard');
    expect(screen.getByTestId('operator-name')).toHaveTextContent('Alexander B.');
  });
});
