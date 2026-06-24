// Authorized by HUB-1569 — smoke test: /console/login renders "HUB Console" without console errors
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
      expect(screen.getByText('HUB Console')).toBeInTheDocument();
    });
  });

  it('does not emit console errors on mount', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('HUB Console')).toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('redirects unknown routes to /console/login', async () => {
    window.history.pushState({}, '', '/unknown-route');
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('HUB Console')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe('/console/login');
  });
});
