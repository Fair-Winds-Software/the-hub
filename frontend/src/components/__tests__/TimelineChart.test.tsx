// Authorized by HUB-1621 (E-FE-8 S2) — TimelineChart tests. Covers data render
// (line + points), annotation severities + tooltip (<title> child) wiring, y-label
// + tick formatting per valueFormat, loading / error / empty states, screen-reader
// data-table fallback, custom + composed aria-label, and axe-core a11y.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { TimelineChart, type TimelineAnnotation } from '../TimelineChart';

afterEach(() => {
  cleanup();
});

const DATA = [
  { date: '2026-04-01', value: 80 },
  { date: '2026-05-01', value: 85 },
  { date: '2026-06-01', value: 92 },
];

const ANNOTATIONS: TimelineAnnotation[] = [
  { date: '2026-05-01', label: 'SOC 2 audit kickoff', severity: 'info' },
  { date: '2026-06-01', label: 'Drift detected', severity: 'warning' },
];

describe('TimelineChart (HUB-1621)', () => {
  describe('AC#1/#2 — data renders as line + points', () => {
    it('renders one SVG with a path per series + a <circle> per data point', () => {
      const { container } = render(
        <TimelineChart data={DATA} yLabel="Compliance %" />,
      );
      expect(screen.getByTestId('timeline-chart-svg')).toBeInTheDocument();
      // 1 line path + 3 point circles (no annotation markers here).
      expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(
        1,
      );
      expect(container.querySelectorAll('circle').length).toBeGreaterThanOrEqual(
        DATA.length,
      );
    });

    it('renders the y-axis label', () => {
      render(<TimelineChart data={DATA} yLabel="Compliance %" />);
      expect(screen.getByTestId('timeline-y-label').textContent).toBe(
        'Compliance %',
      );
    });
  });

  describe('AC#3/#4 — annotations with severity coloring + tooltip text', () => {
    it('renders an annotation marker per annotation, keyed by severity + date', () => {
      render(
        <TimelineChart
          data={DATA}
          yLabel="Compliance %"
          annotations={ANNOTATIONS}
        />,
      );
      expect(
        screen.getByTestId('timeline-annotation-info-2026-05-01'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('timeline-annotation-warning-2026-06-01'),
      ).toBeInTheDocument();
    });

    it('annotation tooltip surfaces via SVG <title> child (browser-native)', () => {
      render(
        <TimelineChart
          data={DATA}
          yLabel="Compliance %"
          annotations={ANNOTATIONS}
        />,
      );
      const ann = screen.getByTestId('timeline-annotation-info-2026-05-01');
      const title = ann.querySelector('title');
      expect(title?.textContent).toBe('2026-05-01: SOC 2 audit kickoff');
    });

    it('annotation whose date is NOT in data is silently dropped', () => {
      render(
        <TimelineChart
          data={DATA}
          yLabel="Compliance %"
          annotations={[
            { date: '2025-01-01', label: 'Out of range' },
            ...ANNOTATIONS,
          ]}
        />,
      );
      // Out-of-range annotation produces no marker; in-range ones still render.
      expect(
        screen.queryByTestId('timeline-annotation-info-2025-01-01'),
      ).toBeNull();
      expect(
        screen.getByTestId('timeline-annotation-info-2026-05-01'),
      ).toBeInTheDocument();
    });

    it('annotation severity defaults to info when omitted', () => {
      render(
        <TimelineChart
          data={DATA}
          yLabel="Compliance %"
          annotations={[{ date: '2026-04-01', label: 'No severity' }]}
        />,
      );
      expect(
        screen.getByTestId('timeline-annotation-info-2026-04-01'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#5 — valueFormat variants', () => {
    it('integer format renders bare numbers in y-tick labels', () => {
      const { container } = render(
        <TimelineChart
          data={DATA}
          yLabel="Compliance"
          valueFormat="integer"
        />,
      );
      const tickTexts = Array.from(container.querySelectorAll('text'))
        .map((t) => t.textContent ?? '')
        .filter((t) => /^\d+$/.test(t));
      expect(tickTexts.length).toBeGreaterThan(0);
    });

    it('percent format suffixes values with %', () => {
      const { container } = render(
        <TimelineChart
          data={DATA}
          yLabel="Compliance"
          valueFormat="percent"
        />,
      );
      const tickTexts = Array.from(container.querySelectorAll('text'))
        .map((t) => t.textContent ?? '')
        .filter((t) => t.endsWith('%'));
      expect(tickTexts.length).toBeGreaterThan(0);
    });

    it('currency format prefixes values with $', () => {
      const { container } = render(
        <TimelineChart
          data={[{ date: '2026-01-01', value: 1500 }]}
          yLabel="MRR"
          valueFormat="currency"
        />,
      );
      const tickTexts = Array.from(container.querySelectorAll('text'))
        .map((t) => t.textContent ?? '')
        .filter((t) => t.startsWith('$'));
      expect(tickTexts.length).toBeGreaterThan(0);
    });
  });

  describe('AC#6 — loading skeleton', () => {
    it('renders the skeleton when loading=true', () => {
      render(<TimelineChart data={DATA} yLabel="x" loading />);
      expect(
        screen.getByTestId('timeline-chart-skeleton'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('timeline-chart-svg')).toBeNull();
    });
  });

  describe('AC#7 — empty data state', () => {
    it('renders "No data available" when data is empty', () => {
      render(<TimelineChart data={[]} yLabel="x" />);
      expect(screen.getByTestId('timeline-chart-empty')).toBeInTheDocument();
      expect(screen.queryByTestId('timeline-chart-svg')).toBeNull();
    });
  });

  describe('error state', () => {
    it('renders an alert banner when error is provided', () => {
      render(
        <TimelineChart data={DATA} yLabel="x" error="upstream timeout" />,
      );
      expect(screen.getByTestId('timeline-chart-error').textContent).toContain(
        'upstream timeout',
      );
    });
  });

  describe('AC#8 — accessibility', () => {
    it('chart container is role=img with a trend-summarizing aria-label', () => {
      render(<TimelineChart data={DATA} yLabel="Compliance %" />);
      const chart = screen.getByTestId('timeline-chart');
      expect(chart).toHaveAttribute('role', 'img');
      // 3 points going 80 -> 85 -> 92 = trend up.
      expect(chart.getAttribute('aria-label')).toMatch(
        /Compliance % timeline, 3 days, current 92, trend up/,
      );
    });

    it('ariaLabel prop overrides the auto-composed default', () => {
      render(
        <TimelineChart
          data={DATA}
          yLabel="Compliance %"
          ariaLabel="Custom announcement"
        />,
      );
      expect(
        screen.getByLabelText('Custom announcement'),
      ).toBeInTheDocument();
    });

    it('SR data-table fallback contains a row per data point', () => {
      render(<TimelineChart data={DATA} yLabel="Compliance %" />);
      const table = screen.getByTestId('timeline-chart-sr-table');
      expect(table.querySelectorAll('tbody tr')).toHaveLength(DATA.length);
      expect(table.querySelector('caption')?.textContent).toBe(
        'Compliance % time series',
      );
    });

    it('flat trend reports "trend stable"', () => {
      render(
        <TimelineChart
          data={[
            { date: '2026-04-01', value: 80 },
            { date: '2026-05-01', value: 80 },
            { date: '2026-06-01', value: 80 },
          ]}
          yLabel="x"
        />,
      );
      expect(
        screen.getByTestId('timeline-chart').getAttribute('aria-label'),
      ).toMatch(/trend stable/);
    });

    it('descending series reports "trend down"', () => {
      render(
        <TimelineChart
          data={[
            { date: '2026-04-01', value: 95 },
            { date: '2026-05-01', value: 80 },
            { date: '2026-06-01', value: 60 },
          ]}
          yLabel="x"
        />,
      );
      expect(
        screen.getByTestId('timeline-chart').getAttribute('aria-label'),
      ).toMatch(/trend down/);
    });

    it('axe-core scan returns zero violations for a loaded chart', async () => {
      const { container } = render(
        <TimelineChart
          data={DATA}
          yLabel="Compliance %"
          annotations={ANNOTATIONS}
        />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('axe-core scan returns zero violations in the empty state', async () => {
      const { container } = render(<TimelineChart data={[]} yLabel="x" />);
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
