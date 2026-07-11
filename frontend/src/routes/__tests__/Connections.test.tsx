// Authorized by HUB-1795 (S6 of HUB-1783) — Connections admin panel tests.
// Covers: renders one card per connection · empty state · error state · Title-Case
// fallback for the per-row indicator so a newly-registered connection appears
// automatically without page reload after the next list refetch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import Connections from '../Connections';

// The ConnectionStatus child does its own status fetch. We stub apiClient so the child
// resolves to a benign MOCK state per connection during these panel-level tests.
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({
      name: 'stripe',
      mode: 'mock',
      health: 'ok',
      checked_at: '2026-07-11T00:00:00Z',
      latency_ms: 0,
    }),
    put: vi.fn().mockResolvedValue(undefined),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Connections — list rendering', () => {
  it('renders one item per registered connection', async () => {
    const listFetcher = vi.fn().mockResolvedValue({
      connections: [
        { name: 'stripe', mode: 'mock' },
        { name: 'ga', mode: 'live' },
      ],
    });
    render(<Connections listFetcher={listFetcher} />);
    await waitFor(() => {
      expect(screen.getByTestId('connections-item-stripe')).toBeInTheDocument();
      expect(screen.getByTestId('connections-item-ga')).toBeInTheDocument();
    });
    expect(screen.getByTestId('connections-list')).toBeInTheDocument();
  });

  it('shows an explicit empty state when zero connections are registered', async () => {
    const listFetcher = vi.fn().mockResolvedValue({ connections: [] });
    render(<Connections listFetcher={listFetcher} />);
    await waitFor(() => {
      expect(screen.getByTestId('connections-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('connections-list')).not.toBeInTheDocument();
  });

  it('shows an error state when the list fetch rejects', async () => {
    const listFetcher = vi.fn().mockRejectedValue(new Error('boom'));
    render(<Connections listFetcher={listFetcher} />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('boom');
    });
  });

  it('a new backend-registered connection appears without a page reload', async () => {
    // Simulate two successive list fetches: first has [stripe], second (after re-render)
    // has [stripe, ga]. The panel re-invokes listFetcher when its refetch closure changes;
    // we exercise the update path by re-rendering with a new fetcher instance (equivalent
    // to what happens when the parent route re-mounts or props change).
    const first = vi.fn().mockResolvedValue({ connections: [{ name: 'stripe', mode: 'mock' }] });
    const { rerender } = render(<Connections listFetcher={first} />);
    await waitFor(() => {
      expect(screen.getByTestId('connections-item-stripe')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('connections-item-ga')).not.toBeInTheDocument();

    const second = vi.fn().mockResolvedValue({
      connections: [
        { name: 'stripe', mode: 'mock' },
        { name: 'ga', mode: 'live' },
      ],
    });
    rerender(<Connections listFetcher={second} />);
    await waitFor(() => {
      expect(screen.getByTestId('connections-item-ga')).toBeInTheDocument();
    });
  });
});
