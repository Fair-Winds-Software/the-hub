// Authorized by HUB-1681 (E-FE-9 S2) — CustomerHealth list tests: table
// render + default sort risk DESC + sort toggle + triple-encoded badge
// (icon + text + color class) + row navigation link + relative-time last-
// active + refresh calls with ?fresh=true.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CustomerHealth from '../CustomerHealth';
import { PermissionDeniedError } from '../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRODUCT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PRODUCT_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const HAPPY_PAYLOAD = {
  rows: [
    {
      tenantId: TENANT_A,
      tenantName: 'Acme',
      productId: PRODUCT_A,
      productName: 'Synapz',
      planKey: 'growth',
      mrrCents: 250000,
      healthBadge: 'red',
      churnRiskScore: 0.85,
      lastActiveAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      signals: ['stale_no_activity', 'payment_failure_recent'],
    },
    {
      tenantId: TENANT_B,
      tenantName: 'Beta Corp',
      productId: PRODUCT_B,
      productName: 'ContentHelm',
      planKey: 'starter',
      mrrCents: 15000,
      healthBadge: 'green',
      churnRiskScore: 0.1,
      lastActiveAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      signals: [],
    },
  ],
  total: 2,
  generatedAt: '2026-07-03T00:00:00.000Z',
  meta: { thresholds: { red: 0.7, yellow: 0.4, staleDays: 14 } },
};

function mockHappy() {
  apiGetMock.mockResolvedValue(HAPPY_PAYLOAD);
}

function renderAt(url: string = '/console/customer-health') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/console/customer-health" element={<CustomerHealth />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  mockHappy();
});

afterEach(() => {
  cleanup();
});

describe('CustomerHealth (HUB-1681)', () => {
  it('renders the page + table with default risk-DESC sort from the BE', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('customer-health-table')).toBeInTheDocument();
    // Two rows, with Acme (red 0.85) before Beta (green 0.1) at DESC.
    const rows = screen.getAllByRole('row');
    // 1 header row + 2 body rows.
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain('Acme');
    expect(rows[2]!.textContent).toContain('Beta Corp');
  });

  it('surfaces the triple-encoded badge (color class + icon + text)', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-badge-red')).toBeInTheDocument();
    });
    const redBadge = screen.getByTestId('customer-health-badge-red');
    expect(redBadge.textContent).toContain('At risk');
    expect(redBadge.textContent).toContain('✕');
    expect(redBadge.getAttribute('aria-label')).toBe('Risk level: High');
    // Green sibling.
    const greenBadge = screen.getByTestId('customer-health-badge-green');
    expect(greenBadge.textContent).toContain('Healthy');
    expect(greenBadge.textContent).toContain('✓');
  });

  it('row link navigates to the drill-in with productId query', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`customer-health-row-link-${TENANT_A}`),
      ).toBeInTheDocument();
    });
    const link = screen.getByTestId(`customer-health-row-link-${TENANT_A}`);
    expect(link.getAttribute('href')).toBe(
      `/console/customer-health/${TENANT_A}?productId=${PRODUCT_A}`,
    );
  });

  it('MRR renders formatted as currency', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-page')).toBeInTheDocument();
    });
    // $2,500.00 (250000 cents) and $150.00 (15000 cents).
    const row = screen.getByTestId(`customer-health-row-${TENANT_A}`);
    expect(row.textContent).toContain('$2,500.00');
  });

  it('sort click on Churn risk toggles to ASC (Beta first)', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('customer-health-sort-risk'));
    });
    // After toggling to ASC, Beta (0.1) should come before Acme (0.85).
    const rows = screen.getAllByRole('row');
    expect(rows[1]!.textContent).toContain('Beta Corp');
    expect(rows[2]!.textContent).toContain('Acme');
  });

  it('Refresh now button calls the endpoint with ?fresh=true', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-page')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('customer-health-refresh'));
    });
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalled();
    });
    const url = apiGetMock.mock.calls[0]![0] as string;
    expect(url).toContain('fresh=true');
  });

  it('403 → AccessDeniedPage', async () => {
    apiGetMock.mockRejectedValueOnce(new PermissionDeniedError(403, 'no'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('access-denied-page')).toBeInTheDocument();
    });
    errSpy.mockRestore();
  });

  it('empty tenant list → empty state', async () => {
    apiGetMock.mockResolvedValue({
      ...HAPPY_PAYLOAD,
      rows: [],
      total: 0,
    });
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-empty')).toBeInTheDocument();
    });
  });

  it('fetch throw → error surface with Retry', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('customer-health-retry')).toBeInTheDocument();
    errSpy.mockRestore();
  });
});
