// Authorized by HUB-1630 (E-FE-10 S1) — DistributionChart tests. Covers bar
// render (vertical + horizontal layouts), tooltip with items, total label,
// valueFormat variants, loading / error / empty states, SR data-table
// fallback, auto-composed + custom aria-label, and axe-core a11y.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  DistributionChart,
  type DistributionPoint,
} from '../DistributionChart';

afterEach(() => {
  cleanup();
});

const DATA: DistributionPoint[] = [
  { category: 'v1.5', count: 8, items: ['Synapz', 'ContentHelm'] },
  { category: 'v1.4', count: 3, items: ['LaunchKit'] },
  { category: 'v1.3', count: 1 },
];

describe('DistributionChart (HUB-1630)', () => {
  describe('AC#1/#2 — vertical layout bars render', () => {
    it('renders one bar per category with category labels', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      expect(screen.getByTestId('distribution-chart-svg')).toBeInTheDocument();
      for (const p of DATA) {
        expect(
          screen.getByTestId(`distribution-bar-${p.category}`),
        ).toBeInTheDocument();
      }
    });

    it('renders the yLabel as the rotated axis title in vertical layout', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      expect(screen.getByTestId('distribution-chart-axis-label').textContent).toBe(
        'Products',
      );
    });
  });

  describe('horizontal layout', () => {
    it('renders bars sideways and uses the xLabel as the bottom axis title', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="Products"
          yLabel="SDK Version"
          layout="horizontal"
        />,
      );
      expect(screen.getByTestId('distribution-chart-axis-label').textContent).toBe(
        'Products',
      );
      for (const p of DATA) {
        expect(
          screen.getByTestId(`distribution-bar-${p.category}`),
        ).toBeInTheDocument();
      }
    });
  });

  describe('AC#3 — hover tooltip surfaces category + count + items', () => {
    it('SVG <title> child carries the spec tooltip format', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      const bar = screen.getByTestId('distribution-bar-v1.5');
      const title = bar.querySelector('title');
      expect(title?.textContent).toBe(
        'v1.5: 8 — Synapz, ContentHelm',
      );
    });

    it('row without items omits the trailing list in the tooltip', () => {
      render(
        <DistributionChart
          data={[{ category: 'v1.0', count: 4 }]}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      const title = screen
        .getByTestId('distribution-bar-v1.0')
        .querySelector('title');
      expect(title?.textContent).toBe('v1.0: 4');
    });

    it('hover surfaces an above-chart tooltip with the category + count', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      const bar = screen.getByTestId('distribution-bar-v1.5');
      fireEvent.mouseEnter(bar);
      const tooltip = screen.getByTestId('distribution-chart-tooltip');
      expect(tooltip.textContent).toContain('v1.5: 8');
      fireEvent.mouseLeave(bar);
      expect(
        screen.queryByTestId('distribution-chart-tooltip'),
      ).toBeNull();
    });
  });

  describe('AC#4 — total label sums all categories', () => {
    it('renders "Total: 12 items" for our 8+3+1 fixture (default unit)', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      const total = screen.getByTestId('distribution-chart-total');
      expect(total.textContent).toContain('Total:');
      expect(total.textContent).toContain('12');
      expect(total.textContent).toContain('items');
    });

    it('totalUnit prop overrides the default ("products")', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
          totalUnit="products"
        />,
      );
      expect(
        screen.getByTestId('distribution-chart-total').textContent,
      ).toContain('products');
    });
  });

  describe('valueFormat variants', () => {
    it('percent format renders count tick labels with trailing %', () => {
      const { container } = render(
        <DistributionChart
          data={[{ category: 'pass', count: 92 }, { category: 'fail', count: 8 }]}
          xLabel="Result"
          yLabel="Share"
          valueFormat="percent"
        />,
      );
      const ticks = Array.from(container.querySelectorAll('text'))
        .map((t) => t.textContent ?? '')
        .filter((t) => t.endsWith('%'));
      expect(ticks.length).toBeGreaterThan(0);
    });

    it('currency format renders tick labels prefixed with $', () => {
      const { container } = render(
        <DistributionChart
          data={[{ category: 'Q1', count: 12000 }]}
          xLabel="Quarter"
          yLabel="MRR"
          valueFormat="currency"
        />,
      );
      const ticks = Array.from(container.querySelectorAll('text'))
        .map((t) => t.textContent ?? '')
        .filter((t) => t.startsWith('$'));
      expect(ticks.length).toBeGreaterThan(0);
    });
  });

  describe('AC#5 — loading skeleton', () => {
    it('renders skeleton when loading=true', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="x"
          yLabel="y"
          loading
        />,
      );
      expect(
        screen.getByTestId('distribution-chart-skeleton'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('distribution-chart-svg')).toBeNull();
    });
  });

  describe('AC#6 — empty state', () => {
    it('renders "No data available" when data is empty', () => {
      render(<DistributionChart data={[]} xLabel="x" yLabel="y" />);
      expect(
        screen.getByTestId('distribution-chart-empty'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('distribution-chart-svg')).toBeNull();
    });
  });

  describe('error state', () => {
    it('renders an alert banner when error is provided', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="x"
          yLabel="y"
          error="upstream down"
        />,
      );
      expect(
        screen.getByTestId('distribution-chart-error').textContent,
      ).toContain('upstream down');
    });
  });

  describe('AC#7 — accessibility', () => {
    it('chart container is role=img with an auto-composed distribution-summary aria-label', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      const chart = screen.getByTestId('distribution-chart');
      expect(chart).toHaveAttribute('role', 'img');
      // Top-3 by count: 8 v1.5, 3 v1.4, 1 v1.3.
      expect(chart.getAttribute('aria-label')).toMatch(
        /SDK Version distribution: 8 on v1\.5, 3 on v1\.4, 1 on v1\.3/,
      );
    });

    it('ariaLabel prop overrides the auto-composed default', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
          ariaLabel="Custom announcement"
        />,
      );
      expect(
        screen.getByLabelText('Custom announcement'),
      ).toBeInTheDocument();
    });

    it('SR data-table fallback contains a row per category', () => {
      render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      const table = screen.getByTestId('distribution-chart-sr-table');
      expect(table.querySelectorAll('tbody tr')).toHaveLength(DATA.length);
    });

    it('axe-core scan returns zero violations for the loaded chart', async () => {
      const { container } = render(
        <DistributionChart
          data={DATA}
          xLabel="SDK Version"
          yLabel="Products"
        />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('axe-core scan returns zero violations in the empty state', async () => {
      const { container } = render(
        <DistributionChart data={[]} xLabel="x" yLabel="y" />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
