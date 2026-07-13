// Authorized by HUB-1799 (S3 of HUB-1784) — tests for the MockData admin panel shell.
// Covers: mode=live disables controls and shows the explanatory note · mode=mock renders
// snapshot counts + S4/S5 slot placeholders · connection picker renders one option per
// registered connection · error state on fetch failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import MockData from '../MockData';

afterEach(() => {
  cleanup();
});

function makeFetchers(overrides: {
  mode?: 'live' | 'mock';
  connections?: Array<{ name: string; mode: 'live' | 'mock' }>;
  snapshot?: Record<string, number>;
  errorOn?: 'list' | 'status' | 'snapshot';
} = {}) {
  const mode = overrides.mode ?? 'mock';
  const connections = overrides.connections ?? [{ name: 'stripe', mode }];
  const snapshot = overrides.snapshot ?? {
    customers: 3,
    products: 1,
    prices: 1,
    coupons: 0,
    subscriptions: 3,
    invoices: 0,
    discounts: 0,
    balance_transactions: 0,
  };
  return {
    listConnections: vi.fn(async () => {
      if (overrides.errorOn === 'list') throw new Error('list failed');
      return { connections };
    }),
    stripeStatus: vi.fn(async () => {
      if (overrides.errorOn === 'status') throw new Error('status failed');
      return { name: 'stripe', mode, health: 'ok' as const };
    }),
    stripeSnapshot: vi.fn(async () => {
      if (overrides.errorOn === 'snapshot') throw new Error('snapshot failed');
      return { counts: snapshot };
    }),
  };
}

describe('MockData — mode=mock (enabled)', () => {
  it('renders snapshot counts and both S4/S5 slot placeholders', async () => {
    const fetchers = makeFetchers({ mode: 'mock' });
    render(<MockData fetchers={fetchers} />);
    await waitFor(() => {
      expect(screen.getByTestId('mock-data-snapshot')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mock-data-snapshot-customers')).toHaveTextContent('3');
    expect(screen.getByTestId('mock-data-snapshot-subscriptions')).toHaveTextContent('3');
    expect(screen.getByTestId('mock-data-seed-slot')).toBeInTheDocument();
    expect(screen.getByTestId('mock-data-delete-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-data-live-disabled')).not.toBeInTheDocument();
  });

  it('marks the page with data-connection-mode="mock"', async () => {
    const fetchers = makeFetchers({ mode: 'mock' });
    render(<MockData fetchers={fetchers} />);
    await waitFor(() => {
      expect(screen.getByTestId('mock-data-page')).toHaveAttribute('data-connection-mode', 'mock');
    });
  });
});

describe('MockData — mode=live (disabled)', () => {
  it('renders the LIVE-mode explanatory note and hides the seed/delete slots', async () => {
    const fetchers = makeFetchers({ mode: 'live' });
    render(<MockData fetchers={fetchers} />);
    await waitFor(() => {
      expect(screen.getByTestId('mock-data-live-disabled')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).toContain('unavailable while Stripe is in LIVE mode');
    expect(screen.queryByTestId('mock-data-snapshot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-data-seed-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-data-delete-slot')).not.toBeInTheDocument();
  });

  it('marks the page with data-connection-mode="live"', async () => {
    const fetchers = makeFetchers({ mode: 'live' });
    render(<MockData fetchers={fetchers} />);
    await waitFor(() => {
      expect(screen.getByTestId('mock-data-page')).toHaveAttribute('data-connection-mode', 'live');
    });
  });
});

describe('MockData — connection picker', () => {
  it('renders one option per registered connection with Stripe selectable', async () => {
    const fetchers = makeFetchers({
      mode: 'mock',
      connections: [
        { name: 'stripe', mode: 'mock' },
        { name: 'ga', mode: 'live' },
      ],
    });
    render(<MockData fetchers={fetchers} />);
    await waitFor(() => {
      expect(screen.getByTestId('mock-data-connection-picker')).toBeInTheDocument();
    });
    const picker = screen.getByTestId('mock-data-connection-picker') as HTMLSelectElement;
    const options = Array.from(picker.querySelectorAll('option'));
    expect(options).toHaveLength(2);
    // Stripe: enabled. Future connections: disabled with "not implemented yet" note.
    const stripeOpt = options.find((o) => o.value === 'stripe')!;
    const gaOpt = options.find((o) => o.value === 'ga')!;
    expect(stripeOpt.disabled).toBe(false);
    expect(gaOpt.disabled).toBe(true);
    expect(gaOpt.textContent).toContain('not implemented yet');
  });
});

describe('MockData — error state', () => {
  it('surfaces a fetch failure in an alert role', async () => {
    const fetchers = makeFetchers({ errorOn: 'status' });
    render(<MockData fetchers={fetchers} />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('status failed');
    });
  });
});
