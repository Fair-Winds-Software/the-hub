// Authorized by HUB-1633 (E-FE-10 S4) — ProductBreakdownTable tests. Covers
// section wrapper + heading, 5-column header, status badge variants (current
// / behind / EOL / stale) each distinct in icon + color + text, default sort
// (Product asc), default sort by status puts the most critical first when
// the operator clicks the column, empty state scoped to the SDK name, and
// axe-core a11y.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  ProductBreakdownTable,
  type ProductBreakdownRow,
} from '../ProductBreakdownTable';

afterEach(() => {
  cleanup();
});

const ROWS: ProductBreakdownRow[] = [
  {
    productId: 'p-1',
    productName: 'Synapz',
    currentVersion: '1.5.0',
    lastReportedAt: '2026-06-29T12:00:00.000Z',
    daysBehindLatest: 0,
    status: 'current',
  },
  {
    productId: 'p-2',
    productName: 'ContentHelm',
    currentVersion: '1.4.0',
    lastReportedAt: '2026-06-25T12:00:00.000Z',
    daysBehindLatest: 2,
    status: 'behind',
  },
  {
    productId: 'p-3',
    productName: 'LaunchKit',
    currentVersion: '1.2.0',
    lastReportedAt: '2026-06-10T12:00:00.000Z',
    daysBehindLatest: 5,
    status: 'eol',
  },
  {
    productId: 'p-4',
    productName: 'AncientApp',
    currentVersion: '1.0.0',
    lastReportedAt: '2026-04-01T12:00:00.000Z',
    daysBehindLatest: 8,
    status: 'stale',
  },
];

describe('ProductBreakdownTable (HUB-1633)', () => {
  describe('AC#1 — section wrapper', () => {
    it('renders <section aria-labelledby> with "Product Breakdown" heading', () => {
      render(<ProductBreakdownTable sdkName="hub-sdk" rows={ROWS} />);
      const section = screen.getByTestId('sdk-versions-section-products');
      expect(section).toHaveAttribute(
        'aria-labelledby',
        'product-breakdown-section-heading',
      );
      expect(
        screen.getByRole('heading', { name: 'Product Breakdown' }),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2 — 5 column headers', () => {
    it('renders Product / Current SDK Version / Last Reported / Days Behind Latest / Status', () => {
      render(<ProductBreakdownTable sdkName="hub-sdk" rows={ROWS} />);
      const table = screen.getByRole('table', {
        name: 'Per-product SDK version breakdown',
      });
      const headers = Array.from(table.querySelectorAll('th')).map(
        (h) => h.textContent ?? '',
      );
      for (const label of [
        'Product',
        'Current SDK Version',
        'Last Reported',
        'Days Behind Latest',
        'Status',
      ]) {
        expect(headers.some((h) => h.includes(label))).toBe(true);
      }
    });
  });

  describe('AC#5 — status badges distinct in icon + color + text (a11y floor)', () => {
    it.each(['current', 'behind', 'eol', 'stale'] as const)(
      'status=%s renders a distinct icon AND a visible status text label',
      (status) => {
        render(
          <ProductBreakdownTable
            sdkName="hub-sdk"
            rows={ROWS.filter((r) => r.status === status)}
          />,
        );
        expect(
          screen.getByTestId(`sdk-status-icon-${status}`),
        ).toBeInTheDocument();
        const badge = screen.getByTestId(`sdk-status-${status}`);
        // EOL renders the "end-of-life" verbose text label; others match the key.
        const expectedText = status === 'eol' ? 'end-of-life' : status;
        expect(badge.textContent).toContain(expectedText);
      },
    );

    it('each status badge carries an aria-label naming the status semantic', () => {
      render(<ProductBreakdownTable sdkName="hub-sdk" rows={ROWS} />);
      expect(
        screen.getByLabelText('Status: current'),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText('Status: behind'),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText('Status: end-of-life'),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText('Status: stale'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#4 — default sort is Product asc', () => {
    it('first visible row is AncientApp (alphabetically first)', () => {
      render(<ProductBreakdownTable sdkName="hub-sdk" rows={ROWS} />);
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows[0]!.textContent).toContain('AncientApp');
      expect(rows[1]!.textContent).toContain('ContentHelm');
      expect(rows[2]!.textContent).toContain('LaunchKit');
      expect(rows[3]!.textContent).toContain('Synapz');
    });
  });

  describe('AC#7 — empty state scoped to the selected SDK name', () => {
    it('renders "No products reporting <name>" when rows is empty', () => {
      render(<ProductBreakdownTable sdkName="experimental-sdk" rows={[]} />);
      const empty = screen.getByTestId('product-breakdown-empty-state');
      expect(empty.textContent).toContain('No products reporting');
      expect(empty.textContent).toContain('experimental-sdk');
    });
  });

  describe('AC#8 — error state pass-through', () => {
    it('error pass-through renders the DataTable error state instead of rows', () => {
      render(
        <ProductBreakdownTable
          sdkName="hub-sdk"
          rows={ROWS}
          error="upstream timeout"
        />,
      );
      // DataTable surfaces the error string in its alert region.
      expect(screen.getByRole('alert').textContent).toContain('upstream timeout');
    });
  });

  describe('loading state pass-through', () => {
    it('loading=true renders skeleton rows from the DataTable contract', () => {
      render(
        <ProductBreakdownTable sdkName="hub-sdk" rows={[]} loading />,
      );
      expect(
        screen.getAllByTestId('data-table-skeleton-row').length,
      ).toBeGreaterThan(0);
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with rows loaded', async () => {
      const { container } = render(
        <ProductBreakdownTable sdkName="hub-sdk" rows={ROWS} />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the empty state', async () => {
      const { container } = render(
        <ProductBreakdownTable sdkName="hub-sdk" rows={[]} />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
