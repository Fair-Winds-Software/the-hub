// Authorized by HUB-1810 (S8 of HUB-1785) — tests for the per-product BI drill-in.
// react-router-dom is stubbed at the module level so useParams() resolves without
// wrapping the tree in a Router; the productId is supplied via productIdOverride prop.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ productId: '00000000-0000-4000-8000-000000000001' }),
}));

import ProductBiPage from '../ProductBiPage';

const PROD_ID = '00000000-0000-4000-8000-000000000001';

const DEFAULT_CATALOG = {
  catalog: [
    { name: 'daily_active_users', description: 'DAU', type: 'int', rollup: 'sum' },
    { name: 'mrr_cents', description: 'MRR', type: 'int', rollup: 'last' },
  ],
};

const DEFAULT_HEALTH = {
  product_id: PROD_ID,
  health: 'ok' as const,
  as_of: '2026-07-13T11:00:00Z',
  reason: null,
};

const DEFAULT_TREND = {
  product_id: PROD_ID,
  metric: 'daily_active_users',
  window: 'daily' as const,
  range: '30d' as const,
  series: [
    { bucket_start: '2026-07-11T00:00:00Z', value: 100, sample_count: 3 },
    { bucket_start: '2026-07-12T00:00:00Z', value: 150, sample_count: 3 },
    { bucket_start: '2026-07-13T00:00:00Z', value: 200, sample_count: 3 },
  ],
};

function makeFetchers(overrides: {
  catalog?: typeof DEFAULT_CATALOG;
  health?: typeof DEFAULT_HEALTH;
  trend?: typeof DEFAULT_TREND;
  trendError?: string;
}) {
  return {
    catalog: vi.fn().mockResolvedValue(overrides.catalog ?? DEFAULT_CATALOG),
    health: vi.fn().mockResolvedValue(overrides.health ?? DEFAULT_HEALTH),
    trends: vi
      .fn()
      .mockImplementation(async () => {
        if (overrides.trendError) throw new Error(overrides.trendError);
        return overrides.trend ?? DEFAULT_TREND;
      }),
  };
}

afterEach(() => {
  cleanup();
});

describe('ProductBiPage — happy path', () => {
  it('renders health badge, metric picker, chart', async () => {
    const fetchers = makeFetchers({});
    render(<ProductBiPage fetchers={fetchers} productIdOverride={PROD_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('product-bi-health-badge')).toBeInTheDocument();
    });
    expect(screen.getByTestId('product-bi-health-badge').textContent).toContain('ok');
    // Metric picker populated from catalog fetch.
    const picker = screen.getByTestId('product-bi-metric-picker') as HTMLSelectElement;
    const options = Array.from(picker.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['daily_active_users', 'mrr_cents']);
    // Chart section is present.
    await waitFor(() => {
      expect(screen.getByTestId('product-bi-chart')).toBeInTheDocument();
    });
    // Trends called with defaults.
    expect(fetchers.trends).toHaveBeenCalledWith(PROD_ID, {
      metric: 'daily_active_users',
      window: 'daily',
      range: '30d',
    });
  });
});

describe('ProductBiPage — picker changes refetch trends', () => {
  it('changing the metric picker refetches with the new metric', async () => {
    const fetchers = makeFetchers({});
    render(<ProductBiPage fetchers={fetchers} productIdOverride={PROD_ID} />);
    await waitFor(() => expect(fetchers.trends).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.change(screen.getByTestId('product-bi-metric-picker'), {
        target: { value: 'mrr_cents' },
      });
    });
    await waitFor(() => expect(fetchers.trends).toHaveBeenCalledTimes(2));
    expect(fetchers.trends).toHaveBeenLastCalledWith(PROD_ID, {
      metric: 'mrr_cents',
      window: 'daily',
      range: '30d',
    });
  });

  it('changing window picker refetches with the new window', async () => {
    const fetchers = makeFetchers({});
    render(<ProductBiPage fetchers={fetchers} productIdOverride={PROD_ID} />);
    await waitFor(() => expect(fetchers.trends).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.change(screen.getByTestId('product-bi-window-picker'), {
        target: { value: 'hourly' },
      });
    });
    await waitFor(() => expect(fetchers.trends).toHaveBeenCalledTimes(2));
    expect(fetchers.trends.mock.lastCall![1]).toMatchObject({ window: 'hourly' });
  });

  it('changing range picker refetches with the new range', async () => {
    const fetchers = makeFetchers({});
    render(<ProductBiPage fetchers={fetchers} productIdOverride={PROD_ID} />);
    await waitFor(() => expect(fetchers.trends).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.change(screen.getByTestId('product-bi-range-picker'), {
        target: { value: '90d' },
      });
    });
    await waitFor(() => expect(fetchers.trends).toHaveBeenCalledTimes(2));
    expect(fetchers.trends.mock.lastCall![1]).toMatchObject({ range: '90d' });
  });
});

describe('ProductBiPage — empty state', () => {
  it('renders the chart section even when trends return an empty series', async () => {
    const fetchers = makeFetchers({
      trend: { ...DEFAULT_TREND, series: [] },
    });
    render(<ProductBiPage fetchers={fetchers} productIdOverride={PROD_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('product-bi-chart')).toBeInTheDocument();
    });
    // TimelineChart's own no-data messaging is rendered inside.
  });
});

describe('ProductBiPage — server error surfaces in role=alert', () => {
  it('renders the error message from a failed trends fetch', async () => {
    const fetchers = makeFetchers({ trendError: 'unknown metric' });
    render(<ProductBiPage fetchers={fetchers} productIdOverride={PROD_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('product-bi-error').textContent).toContain('unknown metric');
    });
    // The page-level error region has role=alert; TimelineChart may also render its
    // own alert region for the same error. Confirm at least one alert carries the msg.
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('unknown metric'))).toBe(true);
  });
});
