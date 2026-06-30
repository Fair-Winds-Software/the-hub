// Authorized by HUB-1632 (E-FE-10 S3) — DistributionChartSection tests. Covers
// section wrapper + heading, chart wiring (xLabel / yLabel / totalUnit),
// hover tooltip carries the product list (FR-002), empty state scoped to the
// selected SDK name, loading + error pass-through to the underlying chart,
// and axe-core a11y.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  DistributionChartSection,
  type DistributionRow,
} from '../DistributionChartSection';

afterEach(() => {
  cleanup();
});

const ROWS: DistributionRow[] = [
  { version: '1.5.0', productCount: 8, products: ['Synapz', 'ContentHelm'] },
  { version: '1.4.0', productCount: 3, products: ['LaunchKit'] },
  { version: '1.3.0', productCount: 1, products: ['legacy-product'] },
];

describe('DistributionChartSection (HUB-1632)', () => {
  describe('AC#1 — section wrapper + heading', () => {
    it('renders <section aria-labelledby> with the "Distribution" heading', () => {
      render(<DistributionChartSection sdkName="hub-sdk" rows={ROWS} />);
      const section = screen.getByTestId('sdk-versions-section-distribution');
      expect(section).toHaveAttribute(
        'aria-labelledby',
        'distribution-chart-section-heading',
      );
      expect(
        screen.getByRole('heading', { name: 'Distribution' }),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2/#3 — chart wiring', () => {
    it('renders the DistributionChart SVG with SDK Version + Product Count labels', () => {
      render(<DistributionChartSection sdkName="hub-sdk" rows={ROWS} />);
      expect(screen.getByTestId('distribution-chart-svg')).toBeInTheDocument();
      // Vertical layout (default): the rotated axis title is yLabel (Product Count).
      expect(
        screen.getByTestId('distribution-chart-axis-label').textContent,
      ).toBe('Product Count');
    });

    it('total label sums the productCounts using the "products" unit', () => {
      render(<DistributionChartSection sdkName="hub-sdk" rows={ROWS} />);
      const total = screen.getByTestId('distribution-chart-total');
      expect(total.textContent).toContain('Total:');
      expect(total.textContent).toContain('12'); // 8 + 3 + 1
      expect(total.textContent).toContain('products');
    });
  });

  describe('FR-002 — hover tooltip carries the product list', () => {
    it('SVG <title> on a bar surfaces version + count + product list', () => {
      render(<DistributionChartSection sdkName="hub-sdk" rows={ROWS} />);
      const bar = screen.getByTestId('distribution-bar-1.5.0');
      const title = bar.querySelector('title');
      expect(title?.textContent).toBe(
        '1.5.0: 8 — Synapz, ContentHelm',
      );
    });
  });

  describe('AC#6 — empty state scoped to the selected SDK name', () => {
    it('renders "No SDK reports for <name>" when rows is empty', () => {
      render(<DistributionChartSection sdkName="experimental-sdk" rows={[]} />);
      const empty = screen.getByTestId('distribution-section-empty');
      expect(empty.textContent).toMatch(
        /No SDK reports for/,
      );
      expect(empty.textContent).toContain('experimental-sdk');
      // Chart not mounted in the empty branch.
      expect(screen.queryByTestId('distribution-chart-svg')).toBeNull();
    });
  });

  describe('AC#7/#8 — loading + error pass-through', () => {
    it('loading=true renders the chart skeleton', () => {
      render(
        <DistributionChartSection sdkName="hub-sdk" rows={ROWS} loading />,
      );
      expect(
        screen.getByTestId('distribution-chart-skeleton'),
      ).toBeInTheDocument();
    });

    it('error renders the chart error banner', () => {
      render(
        <DistributionChartSection
          sdkName="hub-sdk"
          rows={ROWS}
          error="upstream down"
        />,
      );
      expect(
        screen.getByTestId('distribution-chart-error').textContent,
      ).toContain('upstream down');
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with rows loaded', async () => {
      const { container } = render(
        <DistributionChartSection sdkName="hub-sdk" rows={ROWS} />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the empty state', async () => {
      const { container } = render(
        <DistributionChartSection sdkName="hub-sdk" rows={[]} />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
