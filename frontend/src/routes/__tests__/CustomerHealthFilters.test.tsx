// Authorized by HUB-1682 (E-FE-9 S3) — filter sidebar + URL state + CSV
// export tests. Uses the same route + mock scaffold as S2's list test.
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
import {
  buildCsv,
  todayFilename,
} from '../customerHealth/customerHealthCsv';
import type { HealthListRow } from '../CustomerHealth';

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
      lastActiveAt: new Date('2026-05-15T00:00:00.000Z').toISOString(),
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
      lastActiveAt: new Date('2026-07-02T00:00:00.000Z').toISOString(),
      signals: [],
    },
  ] as HealthListRow[],
  total: 2,
  generatedAt: '2026-07-03T00:00:00.000Z',
  meta: { thresholds: { red: 0.7, yellow: 0.4, staleDays: 14 } },
};

function mockHappy() {
  apiGetMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve({
        data: [
          { productId: PRODUCT_A, productName: 'Synapz' },
          { productId: PRODUCT_B, productName: 'ContentHelm' },
        ],
      });
    }
    return Promise.resolve(HAPPY_PAYLOAD);
  });
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

describe('CustomerHealthFilters — sidebar + URL state (HUB-1682)', () => {
  it('renders the sidebar with product options from /admin/portfolio/products', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-filters')).toBeInTheDocument();
    });
    const select = screen.getByTestId(
      'customer-health-filter-product',
    ) as HTMLSelectElement;
    // Default + 2 products.
    expect(select.options).toHaveLength(3);
    expect(select.options[1]!.textContent).toBe('Synapz');
    expect(select.options[2]!.textContent).toBe('ContentHelm');
  });

  it('URL loads with filter query params restore the filter state', async () => {
    await act(async () => {
      renderAt(
        `/console/customer-health?product=${PRODUCT_A}&risk=high&mrrMin=100000`,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-page')).toBeInTheDocument();
    });
    const select = screen.getByTestId(
      'customer-health-filter-product',
    ) as HTMLSelectElement;
    expect(select.value).toBe(PRODUCT_A);
    expect(
      (screen.getByTestId('customer-health-filter-risk-high') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByTestId('customer-health-filter-mrr-min') as HTMLInputElement)
        .value,
    ).toBe('1000');
  });

  it('checking a risk checkbox threads riskLevel into the fetch query', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-page')).toBeInTheDocument();
    });
    apiGetMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('customer-health-filter-risk-high'));
    });
    await waitFor(() => {
      const healthCall = apiGetMock.mock.calls.find((c: unknown[]) =>
        (c[0] as string).startsWith('/api/v1/admin/customer-health'),
      );
      expect(healthCall).toBeDefined();
      expect(healthCall![0]).toContain('riskLevel=high');
    });
  });

  it('MRR min input filters Beta Corp (15000 cents) out client-side', async () => {
    await act(async () => {
      renderAt();
    });
    await waitFor(() => {
      expect(screen.getByTestId(`customer-health-row-${TENANT_B}`)).toBeInTheDocument();
    });
    const minInput = screen.getByTestId('customer-health-filter-mrr-min') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(minInput, { target: { value: '2000' } });
      // Debounce is 300ms; advance by waiting.
      await new Promise((r) => setTimeout(r, 350));
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`customer-health-row-${TENANT_B}`)).toBeNull();
    });
    expect(screen.getByTestId(`customer-health-row-${TENANT_A}`)).toBeInTheDocument();
  });

  it('Reset button clears the sidebar back to defaults', async () => {
    await act(async () => {
      renderAt(`/console/customer-health?product=${PRODUCT_A}&risk=high`);
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-page')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('customer-health-reset'));
    });
    const select = screen.getByTestId(
      'customer-health-filter-product',
    ) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(
      (screen.getByTestId('customer-health-filter-risk-high') as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it('empty state with active filters offers an inline Reset filters CTA', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/admin/portfolio/products')) {
        return Promise.resolve({
          data: [{ productId: PRODUCT_A, productName: 'Synapz' }],
        });
      }
      return Promise.resolve({ ...HAPPY_PAYLOAD, rows: [], total: 0 });
    });
    await act(async () => {
      renderAt(`/console/customer-health?product=${PRODUCT_A}`);
    });
    await waitFor(() => {
      expect(screen.getByTestId('customer-health-empty')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('customer-health-empty').textContent,
    ).toContain('No tenants match your filters');
    expect(
      screen.getByTestId('customer-health-empty-reset'),
    ).toBeInTheDocument();
  });
});

describe('customerHealthCsv (HUB-1682)', () => {
  it('buildCsv includes header + escaped tenant with commas', () => {
    const rows: HealthListRow[] = [
      {
        tenantId: TENANT_A,
        tenantName: 'Acme, Inc.',
        productId: PRODUCT_A,
        productName: 'Synapz',
        planKey: 'growth',
        mrrCents: 250000,
        healthBadge: 'red',
        churnRiskScore: 0.85,
        lastActiveAt: '2026-05-15T00:00:00.000Z',
        signals: ['stale_no_activity', 'payment_failure_recent'],
      },
    ];
    const csv = buildCsv(rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'Tenant,Product,Plan,MRR,Risk level,Churn risk,Last active,Signals',
    );
    expect(lines[1]).toContain('"Acme, Inc."');
    // Currency formatter emits "$2,500.00" which is quoted in CSV because
    // of the comma — so the raw line contains the literal escaped cell.
    expect(lines[1]).toContain('"$2,500.00"');
    expect(lines[1]).toContain('High');
    expect(lines[1]).toContain('0.85');
    expect(lines[1]).toContain('stale_no_activity; payment_failure_recent');
  });

  it('todayFilename uses YYYY-MM-DD local date', () => {
    // Local-timezone-safe construction (avoids UTC → local skew where
    // 2026-07-03T00:00Z becomes 2026-07-02 in US TZs).
    const filename = todayFilename(new Date(2026, 6, 3));
    expect(filename).toBe('customer-health-2026-07-03.csv');
  });
});
