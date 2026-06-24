// Authorized by HUB-1569 — smoke test: /console/login renders without console errors
// Authorized by HUB-1576 — assertions updated for the real Login form replacing the placeholder
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';

describe('App scaffold smoke test', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.pushState({}, '', '/console/login');
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
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
});
