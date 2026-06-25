// Authorized by HUB-1569 — smoke test: /console/login renders without console errors
// Authorized by HUB-1576 — assertions updated for the real Login form replacing the placeholder
// Authorized by HUB-1579 — drainer-on-mount assertion (AC#4 wiring)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';

describe('App scaffold smoke test', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.history.pushState({}, '', '/console/login');
    window.sessionStorage.clear();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Per-path mock: /refresh returns 401 (HUB-1581 hydrate-on-mount path — keeps the
    // smoke test user unauthenticated). All other paths (including /logout for the drain
    // test) return a fresh 200 Response each call (body can only be read once).
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/admin/auth/refresh')) {
        return new Response(JSON.stringify({ error: 'no_refresh' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    window.sessionStorage.clear();
  });

  it('renders the /console/login placeholder', async () => {
    render(<App />);
    await waitFor(() => {
      // HUB-1576 replaced HUB-1569's placeholder text with the real Login form.
      expect(screen.getByRole('button', { name: /Sign In/i })).toBeInTheDocument();
    });
  });

  it('does not emit console errors on mount', async () => {
    render(<App />);
    await waitFor(() => {
      // HUB-1576 replaced HUB-1569's placeholder text with the real Login form.
      expect(screen.getByRole('button', { name: /Sign In/i })).toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('redirects unknown routes to /console/login', async () => {
    window.history.pushState({}, '', '/unknown-route');
    render(<App />);
    await waitFor(() => {
      // HUB-1576 replaced HUB-1569's placeholder text with the real Login form.
      expect(screen.getByRole('button', { name: /Sign In/i })).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe('/console/login');
  });

  it('HUB-1579 AC#4: drains pendingRevokes on mount and clears them on BE success', async () => {
    window.sessionStorage.setItem(
      'hub.pendingRevokes',
      JSON.stringify([
        { refreshToken: 'rt-queued-1', queuedAt: '2026-06-24T12:00:00Z' },
        { refreshToken: 'rt-queued-2', queuedAt: '2026-06-24T12:01:00Z' },
      ]),
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sign In/i })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/admin/auth/logout',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    // Drainer iterates serially; the queue is written back only after all entries are
    // processed, so we wait for the final cleared state rather than asserting eagerly.
    // Total fetch count = 1 refresh (hydrate-on-mount per HUB-1581) + 2 logouts (drain).
    await waitFor(() => {
      const logoutCalls = fetchMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/api/v1/admin/auth/logout'),
      );
      expect(logoutCalls).toHaveLength(2);
      expect(window.sessionStorage.getItem('hub.pendingRevokes')).toBeNull();
    });
  });
});
