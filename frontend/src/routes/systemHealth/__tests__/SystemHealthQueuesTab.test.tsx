// Authorized by HUB-1678 (E-FE-7 S5) — Queues tab tests. Covers table
// render + worst-on-top sort + DLQ triple-encoding for non-zero rows +
// oldest-job age humanizer + refresh flow + axe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import SystemHealthQueuesTab from '../SystemHealthQueuesTab';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

function mockQueues(
  queues: unknown[] = [
    { name: 'queue:stripe-event', depth: 12, dlqSize: 3, oldestJobAgeSeconds: 300 },
    { name: 'queue:dlq', depth: 0, dlqSize: 0, oldestJobAgeSeconds: null },
  ],
) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/system-health/queues')) {
      return Promise.resolve({
        queues,
        generatedAt: '2026-06-30T00:00:00.000Z',
      });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderTab() {
  return render(
    <MemoryRouter>
      <SystemHealthQueuesTab />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SystemHealthQueuesTab (HUB-1678)', () => {
  it('renders one row per queue with numbers formatted via Intl', async () => {
    mockQueues([
      { name: 'queue:a', depth: 1500, dlqSize: 0, oldestJobAgeSeconds: 90 },
    ]);
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('queues-tab')).toBeInTheDocument();
    });
    const row = screen.getByTestId('queues-row-queue:a');
    // 1500 rendered with thousands separator.
    expect(row.textContent).toMatch(/1,500/);
    // 90s → "1m" per the FE humanizer.
    expect(row.textContent).toMatch(/1m/);
  });

  it('worst-on-top sort: DLQ-hot queues rank above DLQ-clean, then by depth', async () => {
    mockQueues([
      { name: 'queue:clean-big', depth: 100, dlqSize: 0, oldestJobAgeSeconds: null },
      { name: 'queue:hot-small', depth: 5, dlqSize: 2, oldestJobAgeSeconds: null },
    ]);
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('queues-tab')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId(/^queues-row-/);
    expect(rows[0]!.getAttribute('data-testid')).toBe('queues-row-queue:hot-small');
    expect(rows[1]!.getAttribute('data-testid')).toBe('queues-row-queue:clean-big');
  });

  it('DLQ triple-encoding: non-zero rows render the hot pill; zero rows render plain', async () => {
    mockQueues();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('queues-tab')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('queues-dlq-hot-queue:stripe-event'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('queues-dlq-zero-queue:dlq'),
    ).toBeInTheDocument();
  });

  it('Refresh now fires the ?fresh=true endpoint + surfaces the transient badge', async () => {
    mockQueues();
    await act(async () => {
      renderTab();
    });
    await waitFor(() => {
      expect(screen.getByTestId('queues-tab')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/v1/admin/system-health/queues')) {
        return Promise.resolve({
          queues: [],
          generatedAt: '2026-06-30T00:00:00.000Z',
        });
      }
      return Promise.reject(new Error('unexpected'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queues-refresh'));
      await Promise.resolve();
      await Promise.resolve();
    });
    const call = apiGetMock.mock.calls[0]![0] as string;
    expect(call).toContain('fresh=true');
    expect(
      screen.getByTestId('queues-refreshed-badge'),
    ).toBeInTheDocument();
  });

  it('passes axe scan in the ready state', async () => {
    mockQueues();
    const { container } = renderTab();
    await waitFor(() => {
      expect(screen.getByTestId('queues-tab')).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
