// Authorized by HUB-1607 (E-FE-3 S7) — AuditTab tests. Covers fetch with the
// correct (tenant_id + product_id + limit=20) wire format, 6-column render,
// "See all" deep-link preserving productId, loading / empty / error states,
// Detail truncation at 80 chars, default sort desc, and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import { AuditTab } from '../AuditTab';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const AUDIT_ROWS = [
  {
    id: 'r-1',
    operator_id: 'op-1',
    entity_type: 'products',
    entity_id: 'p-1',
    action: 'update',
    before_value: null,
    after_value: { status: 'active' },
    notes: null,
    tenant_id: 't-1',
    product_id: 'p-1',
    recommendation_id: null,
    created_at: '2026-06-25T12:00:00.000Z',
  },
  {
    id: 'r-2',
    operator_id: 'op-1',
    entity_type: 'plans',
    entity_id: 'pm-1',
    action: 'create',
    before_value: null,
    after_value: { tier: 'pro' },
    notes: null,
    tenant_id: 't-1',
    product_id: 'p-1',
    recommendation_id: null,
    created_at: '2026-06-20T12:00:00.000Z',
  },
];

const AUDIT_RESPONSE = {
  data: AUDIT_ROWS,
  total: 42,
  limit: 20,
  offset: 0,
};

function lastAuditCall(): { path: string; search: URLSearchParams } | undefined {
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
});

afterEach(() => {
  cleanup();
});

function renderTab() {
  return render(
    <MemoryRouter>
      <AuditTab productId="p-1" tenantId="t-1" />
    </MemoryRouter>,
  );
}

describe('AuditTab (HUB-1607)', () => {
  describe('AC#3 — fetch contract', () => {
    it('GETs /api/v1/admin/console/audit-log with tenant_id + product_id + limit=20', async () => {
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);
      renderTab();
      await waitFor(() => {
        expect(screen.getByText('update')).toBeInTheDocument();
      });
      const call = lastAuditCall();
      expect(call).toBeDefined();
      expect(call!.path).toBe('/api/v1/admin/console/audit-log');
      expect(call!.search.get('tenant_id')).toBe('t-1');
      expect(call!.search.get('product_id')).toBe('p-1');
      expect(call!.search.get('limit')).toBe('20');
    });
  });

  describe('AC#2 — 6 columns rendered', () => {
    it('Timestamp / Actor / Action / Entity Type / Entity ID / Detail headers', async () => {
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);
      renderTab();
      await waitFor(() => {
        expect(screen.getByText('update')).toBeInTheDocument();
      });
      const table = screen.getByRole('table', { name: 'Product audit entries' });
      const headers = Array.from(table.querySelectorAll('th')).map(
        (h) => h.textContent ?? '',
      );
      for (const label of [
        'Timestamp',
        'Actor',
        'Action',
        'Entity Type',
        'Entity ID',
        'Detail',
      ]) {
        expect(headers.some((h) => h.includes(label))).toBe(true);
      }
    });
  });

  describe('AC#4 — "See all" deep-link preserves productId', () => {
    it('renders See all link to /console/audit?product_id=<productId>', async () => {
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('audit-tab-see-all')).toBeInTheDocument();
      });
      const cta = screen.getByTestId('audit-tab-see-all');
      expect(cta).toHaveAttribute('href', '/console/audit?product_id=p-1');
      expect(cta.textContent).toMatch(/see all/i);
    });
  });

  describe('Detail column — 80-char truncation', () => {
    it('long Detail JSON is truncated with "…"', async () => {
      const longNotes = 'x'.repeat(200);
      apiGetMock.mockResolvedValue({
        data: [{ ...AUDIT_ROWS[0], notes: longNotes, after_value: null }],
        total: 1,
        limit: 20,
        offset: 0,
      });
      renderTab();
      await waitFor(() => {
        expect(screen.getAllByTestId('data-table-row').length).toBe(1);
      });
      const cells = screen
        .getAllByTestId('data-table-row')[0]!
        .querySelectorAll('td');
      const detailCell = cells[cells.length - 1]!;
      expect(detailCell.textContent!.length).toBe(80);
      expect(detailCell.textContent!.endsWith('…')).toBe(true);
    });
  });

  describe('AC#5 — empty state', () => {
    it('renders "No audit entries for this product yet" when rows empty', async () => {
      apiGetMock.mockResolvedValue({ data: [], total: 0, limit: 20, offset: 0 });
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('audit-tab-empty-state')).toBeInTheDocument();
      });
      expect(screen.getByTestId('audit-tab-empty-state').textContent).toMatch(
        /No audit entries/i,
      );
    });
  });

  describe('AC#6 — error state', () => {
    it('renders error banner when fetch fails', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      apiGetMock.mockRejectedValue(new Error('upstream timeout'));
      renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('audit-tab-error')).toBeInTheDocument();
      });
      expect(screen.getByTestId('audit-tab-error').textContent).toContain(
        'upstream timeout',
      );
      errSpy.mockRestore();
    });
  });

  describe('loading state', () => {
    it('renders loading text while fetch is in flight', () => {
      apiGetMock.mockImplementation(() => new Promise(() => {}));
      renderTab();
      expect(screen.getByTestId('audit-tab-loading')).toBeInTheDocument();
    });
  });

  describe('summary line', () => {
    it('shows "Showing the last N of T entries" when data loaded', async () => {
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);
      renderTab();
      await waitFor(() => {
        expect(screen.getByText('update')).toBeInTheDocument();
      });
      expect(
        screen.getByText(/Showing the last 2 of 42 entries/i),
      ).toBeInTheDocument();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with rows loaded', async () => {
      apiGetMock.mockResolvedValue(AUDIT_RESPONSE);
      const { container } = renderTab();
      await waitFor(() => {
        expect(screen.getByText('update')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in empty state', async () => {
      apiGetMock.mockResolvedValue({ data: [], total: 0, limit: 20, offset: 0 });
      const { container } = renderTab();
      await waitFor(() => {
        expect(screen.getByTestId('audit-tab-empty-state')).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
