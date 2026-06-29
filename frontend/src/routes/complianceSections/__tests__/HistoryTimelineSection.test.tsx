// Authorized by HUB-1624 (E-FE-8 S5) — HistoryTimelineSection tests. Covers the
// drop-detection algorithm (warning 5-10pt; error >10pt; no annotation at <=5pt),
// chart wiring (data + y-label + valueFormat), empty / loading / error states,
// tooltip label format, the empty-state Settings link, and axe-core a11y.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import {
  HistoryTimelineSection,
  computeDrops,
} from '../HistoryTimelineSection';

afterEach(() => {
  cleanup();
});

function renderSection(
  props: Partial<React.ComponentProps<typeof HistoryTimelineSection>> = {},
) {
  return render(
    <MemoryRouter>
      <HistoryTimelineSection history={[]} {...props} />
    </MemoryRouter>,
  );
}

describe('computeDrops (HUB-1624 — pure helper)', () => {
  it('returns empty when history has <2 points', () => {
    expect(computeDrops([])).toEqual([]);
    expect(computeDrops([{ date: '2026-06-01', score: 90 }])).toEqual([]);
  });

  it('no drop annotation when consecutive drop is <=5 pts', () => {
    expect(
      computeDrops([
        { date: '2026-06-01', score: 90 },
        { date: '2026-06-02', score: 85 },
      ]),
    ).toEqual([]);
  });

  it('warning band: drop > 5 and <= 10 pts surfaces a drop', () => {
    const drops = computeDrops([
      { date: '2026-06-01', score: 90 },
      { date: '2026-06-02', score: 82 },
    ]);
    expect(drops).toEqual([
      {
        date: '2026-06-02',
        previousScore: 90,
        currentScore: 82,
        dropPoints: 8,
      },
    ]);
  });

  it('error band: drop > 10 pts surfaces a drop', () => {
    const drops = computeDrops([
      { date: '2026-06-01', score: 92 },
      { date: '2026-06-02', score: 80 },
    ]);
    expect(drops[0]).toMatchObject({ dropPoints: 12 });
  });

  it('detects multiple drops across the series and IGNORES recoveries', () => {
    const drops = computeDrops([
      { date: '2026-06-01', score: 90 }, // start
      { date: '2026-06-02', score: 80 }, // -10 (warning)
      { date: '2026-06-03', score: 75 }, // -5 (NOT > 5; ignored)
      { date: '2026-06-04', score: 90 }, // +15 (recovery; ignored)
      { date: '2026-06-05', score: 75 }, // -15 (error)
    ]);
    expect(drops.map((d) => d.date)).toEqual([
      '2026-06-02',
      '2026-06-05',
    ]);
  });
});

describe('HistoryTimelineSection (HUB-1624)', () => {
  describe('AC#1 — section wrapper + heading', () => {
    it('renders <section aria-labelledby> with the "Verdict History" heading', () => {
      renderSection({
        history: [
          { date: '2026-06-01', score: 90 },
          { date: '2026-06-02', score: 92 },
        ],
      });
      const section = screen.getByTestId(
        'compliance-section-verdict-history',
      );
      expect(section).toHaveAttribute(
        'aria-labelledby',
        'history-timeline-heading',
      );
      expect(
        screen.getByRole('heading', { name: 'Verdict History' }),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2/#4 — chart wiring (y-label + valueFormat)', () => {
    it('renders the TimelineChart SVG with y-label "Posture Score" when data is present', () => {
      renderSection({
        history: [
          { date: '2026-06-01', score: 90 },
          { date: '2026-06-02', score: 92 },
        ],
      });
      expect(screen.getByTestId('timeline-chart-svg')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-y-label').textContent).toBe(
        'Posture Score',
      );
    });
  });

  describe('AC#3/#5 — annotations + tooltip format', () => {
    it('warning severity for 8pt drop; tooltip carries the spec label', () => {
      renderSection({
        history: [
          { date: '2026-06-01', score: 90 },
          { date: '2026-06-02', score: 82 },
        ],
      });
      const ann = screen.getByTestId(
        'timeline-annotation-warning-2026-06-02',
      );
      expect(ann).toBeInTheDocument();
      const title = ann.querySelector('title');
      expect(title?.textContent).toBe(
        '2026-06-02: Score dropped 8 points on 2026-06-02 (was 90, now 82)',
      );
    });

    it('error severity for 12pt drop', () => {
      renderSection({
        history: [
          { date: '2026-06-01', score: 92 },
          { date: '2026-06-02', score: 80 },
        ],
      });
      expect(
        screen.getByTestId('timeline-annotation-error-2026-06-02'),
      ).toBeInTheDocument();
    });

    it('drops at exactly 5 points produce NO annotation (strict greater-than)', () => {
      renderSection({
        history: [
          { date: '2026-06-01', score: 90 },
          { date: '2026-06-02', score: 85 },
        ],
      });
      expect(
        screen.queryByTestId('timeline-annotation-warning-2026-06-02'),
      ).toBeNull();
      expect(
        screen.queryByTestId('timeline-annotation-error-2026-06-02'),
      ).toBeNull();
    });
  });

  describe('AC#7 — empty data state with Settings CTA', () => {
    it('renders "No history available — first evaluation pending" + Settings link', () => {
      renderSection({ history: [] });
      expect(
        screen.getByTestId('history-timeline-empty'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/first evaluation pending/i),
      ).toBeInTheDocument();
      expect(screen.getByTestId('history-timeline-empty-cta')).toHaveAttribute(
        'href',
        '/console/settings',
      );
    });
  });

  describe('AC#8 — loading skeleton passes through to TimelineChart', () => {
    it('loading=true renders the chart skeleton', () => {
      renderSection({
        history: [
          { date: '2026-06-01', score: 90 },
          { date: '2026-06-02', score: 92 },
        ],
        loading: true,
      });
      expect(
        screen.getByTestId('timeline-chart-skeleton'),
      ).toBeInTheDocument();
    });
  });

  describe('error state pass-through', () => {
    it('error renders the chart error banner', () => {
      renderSection({
        history: [{ date: '2026-06-01', score: 90 }],
        error: 'upstream timeout',
      });
      expect(
        screen.getByTestId('timeline-chart-error').textContent,
      ).toContain('upstream timeout');
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with data + annotations loaded', async () => {
      const { container } = renderSection({
        history: [
          { date: '2026-06-01', score: 92 },
          { date: '2026-06-02', score: 80 },
          { date: '2026-06-03', score: 85 },
        ],
      });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in empty state', async () => {
      const { container } = renderSection({ history: [] });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
