// Authorized by HUB-1648 (E-FE-2 S5) — DashboardSidebar tests. Covers the
// QuickActions row (3 <a> links + href targets + tab order), the recent
// activity feed (fetch, row content, deep-link to /console/audit?eventId=,
// aria-label sentence, empty state, degrade state), widget-isolation of
// the feed failure (does NOT break the quick actions), and axe-core zero
// violations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import { DashboardSidebar } from '../DashboardSidebar';

const apiGetMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

const MK_ENTRY = (over: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  operator_id: '11111111-2222-3333-4444-555555555555',
  entity_type: 'plan_assignment',
  entity_id: 'pa-1',
  action: 'plan_assigned',
  tenant_id: 't-1',
  product_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  recommendation_id: null,
  created_at: new Date(Date.now() - 8 * 60_000).toISOString(),
  ...over,
});

function mockFeed(entries: unknown[]) {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/v1/admin/console/audit-log')) {
      return Promise.resolve({ data: entries, total: entries.length });
    }
    return Promise.reject(new Error(`unexpected: ${path}`));
  });
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <DashboardSidebar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('DashboardSidebar (HUB-1648)', () => {
  describe('AC#1 — QuickActions row (3 <a> links, tab order, deep-link targets)', () => {
    it('renders three action links in source order with the required href targets', () => {
      mockFeed([]);
      renderSidebar();
      const products = screen.getByTestId('dashboard-quick-action-products');
      const newRec = screen.getByTestId(
        'dashboard-quick-action-new-recommendation',
      );
      const audit = screen.getByTestId('dashboard-quick-action-audit');
      // Anchors (open-in-new-tab friendly).
      expect(products.tagName).toBe('A');
      expect(newRec.tagName).toBe('A');
      expect(audit.tagName).toBe('A');
      expect(products.getAttribute('href')).toBe('/console/products');
      // Spec deviation #1: /console/plan-advisor/new (route path) rather
      // than /console/plan-advisor?new=true (query param) — HUB-1639 lives
      // at the route path.
      expect(newRec.getAttribute('href')).toBe(
        '/console/plan-advisor/new',
      );
      expect(audit.getAttribute('href')).toBe('/console/audit');
    });
  });

  describe('AC#2 — activity feed rows (content + deep-link + aria-label sentence)', () => {
    it('renders one row per audit entry with the deep-link target /console/audit?eventId=', async () => {
      mockFeed([MK_ENTRY({ id: 'evt-42' }), MK_ENTRY({ id: 'evt-43' })]);
      await act(async () => {
        renderSidebar();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('dashboard-activity-list'),
        ).toBeInTheDocument();
      });
      const row = screen.getByTestId('activity-row-evt-42');
      expect(row.tagName).toBe('A');
      expect(row.getAttribute('href')).toBe(
        '/console/audit?eventId=evt-42',
      );
      // aria-label composes the full sentence per spec.
      const aria = row.getAttribute('aria-label') ?? '';
      expect(aria).toMatch(/Audit event evt-42/);
      expect(aria).toMatch(/plan assigned/);
      expect(aria).toMatch(/Click to view in audit log\./);
    });

    it('row content surfaces actor short-id + verb + product short-id + relative timestamp', async () => {
      mockFeed([MK_ENTRY({ id: 'evt-99' })]);
      await act(async () => {
        renderSidebar();
      });
      await waitFor(() => {
        expect(screen.getByTestId('activity-row-evt-99')).toBeInTheDocument();
      });
      // Short-ID actor (first 8 chars + …).
      expect(
        screen.getByTestId('activity-row-actor').textContent,
      ).toMatch(/^11111111/);
      expect(
        screen.getByTestId('activity-row-verb').textContent,
      ).toBe('plan assigned');
      // Relative timestamp: ~8 min ago.
      expect(
        screen.getByTestId('activity-row-timestamp').textContent,
      ).toMatch(/8 min ago/);
    });
  });

  describe('AC#3 — empty + degraded states', () => {
    it('empty response renders "Nothing in the last 24 hours" (not a blank panel)', async () => {
      mockFeed([]);
      await act(async () => {
        renderSidebar();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('dashboard-activity-empty'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('dashboard-activity-empty').textContent,
      ).toMatch(/Nothing in the last 24 hours/);
    });

    it('endpoint failure (400/403 or network) degrades to a friendly panel — no error banner cascade', async () => {
      apiGetMock.mockRejectedValue(new Error('PRODUCT_ID_REQUIRED'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        renderSidebar();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('dashboard-activity-degraded'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('dashboard-activity-degraded').textContent,
      ).toMatch(/Activity feed unavailable/);
      // Quick actions row is still fully mounted + interactive.
      expect(
        screen.getByTestId('dashboard-quick-actions'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('dashboard-quick-action-products'),
      ).toBeInTheDocument();
      errSpy.mockRestore();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with a full feed rendered', async () => {
      mockFeed([MK_ENTRY({ id: 'evt-a' }), MK_ENTRY({ id: 'evt-b' })]);
      const { container } = renderSidebar();
      await waitFor(() => {
        expect(
          screen.getByTestId('dashboard-activity-list'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the degraded state', async () => {
      apiGetMock.mockRejectedValue(new Error('down'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { container } = renderSidebar();
      await waitFor(() => {
        expect(
          screen.getByTestId('dashboard-activity-degraded'),
        ).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
      errSpy.mockRestore();
    });
  });
});
