// Authorized by HUB-1809 (S7 of HUB-1785) — tests for the Dashboard BI tile cluster.
// Covers: happy path renders three tiles + as_of footer; 403 → cluster hidden entirely;
// non-403 error → alert; null values → em-dash empty state; per-tile aria labels
// present (via MetricTile).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { BiTileCluster } from '../BiTileCluster';
import { PermissionDeniedError } from '../../../lib/errors';

afterEach(() => {
  cleanup();
});

describe('BiTileCluster — happy path', () => {
  it('renders three tiles + as_of footer with populated values', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      as_of: '2026-07-13T00:00:00Z',
      mrr_cents: 3_500_000,
      daily_active_users: 2000,
      churn_rate: 0.0425,
      per_product: [],
    });
    render(<BiTileCluster fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getByTestId('bi-tile-cluster')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bi-tile-mrr')).toBeInTheDocument();
    expect(screen.getByTestId('bi-tile-dau')).toBeInTheDocument();
    expect(screen.getByTestId('bi-tile-churn')).toBeInTheDocument();
    // Values reach the tiles (formatted).
    expect(screen.getByTestId('bi-tile-dau').textContent).toContain('2,000');
    expect(screen.getByTestId('bi-tile-churn').textContent).toContain('4.25%');
    // MRR renders formatted dollars — accept common formats.
    expect(screen.getByTestId('bi-tile-mrr').textContent).toMatch(/35,?000/);
    expect(screen.getByTestId('bi-tile-cluster-asof')).toBeInTheDocument();
  });
});

describe('BiTileCluster — null / empty values', () => {
  it('renders em-dash for each null value (empty portfolio)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      as_of: '2026-07-13T00:00:00Z',
      mrr_cents: null,
      daily_active_users: null,
      churn_rate: null,
      per_product: [],
    });
    render(<BiTileCluster fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getByTestId('bi-tile-cluster')).toBeInTheDocument();
    });
    // MetricTile's empty renderer shows "—" (em-dash).
    expect(screen.getByTestId('bi-tile-mrr').textContent).toContain('—');
    expect(screen.getByTestId('bi-tile-dau').textContent).toContain('—');
    expect(screen.getByTestId('bi-tile-churn').textContent).toContain('—');
  });
});

describe('BiTileCluster — 403 hides the cluster', () => {
  it('renders NOTHING when the fetcher throws PermissionDeniedError', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(new PermissionDeniedError(403, 'super_admin required'));
    const { container } = render(<BiTileCluster fetcher={fetcher} />);
    await waitFor(() => {
      // Wait for the fetch to reject.
      expect(fetcher).toHaveBeenCalled();
    });
    // After the rejection resolves + state flip, the cluster should render nothing.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="bi-tile-cluster"]')).toBeNull();
      expect(container.querySelector('[data-testid="bi-tile-cluster-error"]')).toBeNull();
      expect(container.querySelector('[data-testid="bi-tile-cluster-loading"]')).toBeNull();
    });
  });
});

describe('BiTileCluster — non-403 error', () => {
  it('renders an alert with the error message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network kaput'));
    render(<BiTileCluster fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getByTestId('bi-tile-cluster-error')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).toContain('network kaput');
  });
});
