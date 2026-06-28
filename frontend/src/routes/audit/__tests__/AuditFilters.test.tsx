// Authorized by HUB-1613 (E-FE-12 S3) — AuditFilters component tests. Covers the 5 filter
// groups, default last-30-days state, 300ms debounce coalescing, reset bypass, date-range
// validation (inverted error blocks fetch; >1y warning still fetches), surfaced loading /
// result / error callbacks, dropdown population, super_admin→product_admin actor degradation,
// and axe-core a11y.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import { AuditFilters } from '../AuditFilters';
import { PermissionDeniedError } from '../../../lib/errors';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const OPERATORS_RESPONSE = [
  { id: 'op-1', email: 'sammy@maverick.launch', role: 'super_admin' },
  { id: 'op-2', email: 'wayne@maverick.launch', role: 'product_admin' },
];

const PRODUCTS_RESPONSE = {
  data: [
    { productId: 'p-1', productName: 'Synapz' },
    { productId: 'p-2', productName: 'ContentHelm' },
  ],
  total: 2,
};

const AUDIT_RESPONSE = {
  data: [
    {
      id: 'r-1',
      operator_id: 'op-1',
      entity_type: 'products',
      entity_id: 'p-1',
      action: 'update',
      before_value: null,
      after_value: null,
      notes: null,
      tenant_id: '0',
      product_id: 'p-1',
      recommendation_id: null,
      created_at: '2026-06-15T00:00:00.000Z',
    },
  ],
  total: 42,
  limit: 50,
  offset: 0,
};

interface MockCall {
  path: string;
  search: URLSearchParams;
}

function lastAuditCall(): MockCall | undefined {
  const calls = apiGetMock.mock.calls
    .map((c) => c[0] as string)
    .filter((p) => p.startsWith('/api/v1/admin/console/audit-log'));
  if (calls.length === 0) return undefined;
  const url = calls[calls.length - 1]!;
  const qsIndex = url.indexOf('?');
  return {
    path: qsIndex === -1 ? url : url.slice(0, qsIndex),
    search: new URLSearchParams(qsIndex === -1 ? '' : url.slice(qsIndex + 1)),
  };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/operators')) {
      return Promise.resolve(OPERATORS_RESPONSE);
    }
    if (path.startsWith('/api/v1/admin/portfolio/products')) {
      return Promise.resolve(PRODUCTS_RESPONSE);
    }
    if (path.startsWith('/api/v1/admin/console/audit-log')) {
      return Promise.resolve(AUDIT_RESPONSE);
    }
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderFilters(initialUrl = '/') {
  const onResults = vi.fn();
  const onLoadingChange = vi.fn();
  const ui = render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <AuditFilters onResults={onResults} onLoadingChange={onLoadingChange} />
    </MemoryRouter>,
  );
  return { ...ui, onResults, onLoadingChange };
}

describe('AuditFilters (HUB-1613)', () => {
  describe('AC#1 — renders 5 filter groups with labels', () => {
    it('renders Actor + Action + Entity type + Product + Date range', () => {
      renderFilters();
      expect(screen.getByLabelText('Actor')).toBeInTheDocument();
      expect(screen.getByLabelText('Action')).toBeInTheDocument();
      expect(screen.getByLabelText('Entity type')).toBeInTheDocument();
      expect(screen.getByLabelText('Product')).toBeInTheDocument();
      expect(screen.getByLabelText('From')).toBeInTheDocument();
      expect(screen.getByLabelText('To')).toBeInTheDocument();
    });
  });

  describe('AC#6 — default state', () => {
    it('From defaults to 30 days before To (which defaults to today)', () => {
      renderFilters();
      const from = screen.getByLabelText('From') as HTMLInputElement;
      const to = screen.getByLabelText('To') as HTMLInputElement;
      const fromDate = new Date(from.value);
      const toDate = new Date(to.value);
      const diffDays = (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeCloseTo(30, 0);
    });
  });

  describe('AC#1 — dropdown population on mount', () => {
    it('Actor dropdown populated from /api/v1/admin/operators', async () => {
      renderFilters();
      await waitFor(() => {
        const actor = screen.getByLabelText('Actor') as HTMLSelectElement;
        expect(actor.tagName).toBe('SELECT');
        const options = Array.from(actor.options).map((o) => o.text);
        expect(options).toEqual(
          expect.arrayContaining(['All actors', expect.stringContaining('sammy@maverick.launch')]),
        );
      });
    });

    it('Product dropdown populated from /api/v1/admin/portfolio/products', async () => {
      renderFilters();
      await waitFor(() => {
        const product = screen.getByLabelText('Product') as HTMLSelectElement;
        const options = Array.from(product.options).map((o) => o.text);
        expect(options).toEqual(expect.arrayContaining(['All products', 'Synapz', 'ContentHelm']));
      });
    });
  });

  describe('Spec deviation #5 — actor degrades to free-text on 403', () => {
    it('renders Actor as <input type="text"> when operators endpoint returns 403', async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/operators')) {
          return Promise.reject(new PermissionDeniedError(403, 'Forbidden'));
        }
        if (path.startsWith('/api/v1/admin/portfolio/products')) {
          return Promise.resolve(PRODUCTS_RESPONSE);
        }
        if (path.startsWith('/api/v1/admin/console/audit-log')) {
          return Promise.resolve(AUDIT_RESPONSE);
        }
        return Promise.reject(new Error('unexpected'));
      });
      renderFilters();
      await waitFor(() => {
        const actor = screen.getByLabelText('Actor');
        expect(actor.tagName).toBe('INPUT');
      });
    });
  });

  describe('AC#2 — 300ms debounced fetch coalescing', () => {
    it('single filter change → fetch fires after 300ms', async () => {
      vi.useFakeTimers();
      renderFilters();
      // Drain mount-time fetches first.
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      });

      apiGetMock.mockClear();
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);

      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'INSERT' } });

      // 299ms — fetch not yet fired
      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(lastAuditCall()).toBeUndefined();

      // 1ms more — fetch fires
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      const call = lastAuditCall();
      expect(call).toBeDefined();
      expect(call!.search.get('action')).toBe('INSERT');
    });

    it('multiple rapid changes within 300ms coalesce into a single fetch with latest values', async () => {
      vi.useFakeTimers();
      renderFilters();
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      });

      apiGetMock.mockClear();
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);

      const action = screen.getByLabelText('Action');
      fireEvent.change(action, { target: { value: 'A' } });
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.change(action, { target: { value: 'AB' } });
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.change(action, { target: { value: 'ABC' } });
      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      const auditCalls = apiGetMock.mock.calls
        .map((c) => c[0] as string)
        .filter((p) => p.startsWith('/api/v1/admin/console/audit-log'));
      expect(auditCalls).toHaveLength(1);
      const call = lastAuditCall();
      expect(call!.search.get('action')).toBe('ABC');
    });
  });

  describe('AC#5 — Reset bypasses debounce', () => {
    it('Reset filters → clears state + immediate fetch (no 300ms wait)', async () => {
      vi.useFakeTimers();
      renderFilters();
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      });

      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'changed' } });
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
      });

      apiGetMock.mockClear();
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);

      fireEvent.click(screen.getByRole('button', { name: /reset filters/i }));
      // Fetch fires WITHOUT advancing timers.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const call = lastAuditCall();
      expect(call).toBeDefined();
      expect(call!.search.get('action')).toBeNull();
    });
  });

  describe('AC#7 — date range validation', () => {
    it('from > to → inline error + NO fetch fires', async () => {
      vi.useFakeTimers();
      renderFilters();
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      });

      apiGetMock.mockClear();
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);

      // Set From to AFTER To.
      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-12-01' } });
      fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-01' } });

      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });

      // Inline error visible.
      expect(screen.getByRole('alert')).toHaveTextContent(/From.*must be on or before.*To/i);
      // No audit fetch fired.
      expect(lastAuditCall()).toBeUndefined();
    });

    it('range > 365 days → warning rendered + fetch STILL fires', async () => {
      vi.useFakeTimers();
      renderFilters();
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      });

      apiGetMock.mockClear();
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);

      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2024-01-01' } });
      fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-01' } });

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      // Warning visible, no alert.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText(/exceeds 1 year/i)).toBeInTheDocument();
      // Fetch did fire (warn-not-block contract).
      const call = lastAuditCall();
      expect(call).toBeDefined();
    });
  });

  describe('AC#8 — loading + result + error callbacks', () => {
    it('surfaces loading true/false and onResults(data, total) on success', async () => {
      vi.useFakeTimers();
      const { onLoadingChange, onResults } = renderFilters();

      // Drain mount-time effects.
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      });

      // After the debounced default fetch resolves, callbacks have fired.
      expect(onLoadingChange).toHaveBeenCalledWith(true);
      expect(onLoadingChange).toHaveBeenCalledWith(false);
      // Latest call to onResults: data + total from AUDIT_RESPONSE.
      const lastCall = onResults.mock.calls[onResults.mock.calls.length - 1]!;
      expect(lastCall[0]).toEqual(AUDIT_RESPONSE.data);
      expect(lastCall[1]).toBe(42);
      expect(lastCall[2]).toBeUndefined();
    });

    it('surfaces onResults(null, 0, error) on failure', async () => {
      vi.useFakeTimers();
      apiGetMock.mockImplementation((path: string) => {
        if (path.startsWith('/api/v1/admin/operators')) return Promise.resolve(OPERATORS_RESPONSE);
        if (path.startsWith('/api/v1/admin/portfolio/products'))
          return Promise.resolve(PRODUCTS_RESPONSE);
        return Promise.reject(new Error('boom'));
      });
      const { onResults } = renderFilters();
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      });
      const lastCall = onResults.mock.calls[onResults.mock.calls.length - 1]!;
      expect(lastCall[0]).toBeNull();
      expect(lastCall[1]).toBe(0);
      expect(lastCall[2]).toMatch(/boom/);
    });
  });

  describe('wire-format — snake_case + comma-separated multi-value (spec deviation #3)', () => {
    it('action/entity_type CSV inputs surface as comma-joined query params', async () => {
      vi.useFakeTimers();
      renderFilters();
      await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
      });
      apiGetMock.mockClear();
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);

      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'INSERT, UPDATE' } });
      fireEvent.change(screen.getByLabelText('Entity type'), {
        target: { value: 'products, plans' },
      });

      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      const call = lastAuditCall();
      expect(call!.search.get('action')).toBe('INSERT,UPDATE');
      expect(call!.search.get('entity_type')).toBe('products,plans');
      // tenant_id always set per spec deviation #4.
      expect(call!.search.get('tenant_id')).toBe('00000000-0000-0000-0000-0000000000a1');
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan on the filter sidebar', async () => {
      const { container } = renderFilters();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
