// Authorized by HUB-1625 (E-FE-8 S6) — DriftSignalsSection tests. Covers list
// render + DESC sort, transition-severity mapping (info / warning / error +
// default-warning fallback), drift banner threshold behavior, empty state with
// green check icon, severity-icon + text-label pairing (a11y AC), and axe-core.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  DriftSignalsSection,
  type DriftSignal,
} from '../DriftSignalsSection';

afterEach(() => {
  cleanup();
});

const SIGNALS: DriftSignal[] = [
  {
    control_id: 'soc2-cc6.1',
    control_name: 'Logical access controls',
    status_from: 'passing',
    status_to: 'failing',
    changed_at: '2026-06-20T12:00:00.000Z',
  },
  {
    control_id: 'soc2-cc7.2',
    control_name: 'Threat detection',
    status_from: 'passing',
    status_to: 'warning',
    changed_at: '2026-06-25T12:00:00.000Z',
  },
  {
    control_id: 'soc2-cc8.1',
    control_name: 'Change management',
    status_from: 'failing',
    status_to: 'passing',
    changed_at: '2026-06-15T12:00:00.000Z',
  },
];

describe('DriftSignalsSection (HUB-1625)', () => {
  describe('AC#1 — section wrapper', () => {
    it('renders <section aria-labelledby> with "Drift Signals" heading', () => {
      render(<DriftSignalsSection signals={SIGNALS} />);
      const section = screen.getByTestId('compliance-section-drift-signals');
      expect(section).toHaveAttribute(
        'aria-labelledby',
        'drift-signals-heading',
      );
      expect(
        screen.getByRole('heading', { name: 'Drift Signals' }),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2/#3 — list rendering with severity icon + transition badge + timestamp', () => {
    it('renders one row per signal with control name + transition text', () => {
      render(<DriftSignalsSection signals={SIGNALS} />);
      expect(
        screen.getByTestId('drift-signal-soc2-cc6.1'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('drift-signal-soc2-cc7.2'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('drift-signal-soc2-cc8.1'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('drift-signal-transition-soc2-cc6.1').textContent,
      ).toMatch(/passing\s*→\s*failing/);
    });

    it('passing → failing maps to error severity icon', () => {
      render(<DriftSignalsSection signals={[SIGNALS[0]!]} />);
      // SeverityIcon for error appears inside the row.
      const row = screen.getByTestId('drift-signal-soc2-cc6.1');
      expect(row.querySelector('[data-testid="drift-icon-error"]')).not.toBeNull();
    });

    it('passing → warning maps to warning severity icon', () => {
      render(<DriftSignalsSection signals={[SIGNALS[1]!]} />);
      const row = screen.getByTestId('drift-signal-soc2-cc7.2');
      expect(row.querySelector('[data-testid="drift-icon-warning"]')).not.toBeNull();
    });

    it('failing → passing maps to info severity icon (recovery)', () => {
      render(<DriftSignalsSection signals={[SIGNALS[2]!]} />);
      const row = screen.getByTestId('drift-signal-soc2-cc8.1');
      expect(row.querySelector('[data-testid="drift-icon-info"]')).not.toBeNull();
    });

    it('unrecognized transition defensively falls back to warning severity', () => {
      const odd: DriftSignal = {
        control_id: 'c-1',
        control_name: 'Weird transition',
        status_from: 'unknown_a',
        status_to: 'unknown_b',
        changed_at: '2026-06-01T00:00:00.000Z',
      };
      render(<DriftSignalsSection signals={[odd]} />);
      const row = screen.getByTestId('drift-signal-c-1');
      expect(row.querySelector('[data-testid="drift-icon-warning"]')).not.toBeNull();
    });
  });

  describe('AC#4 — DESC sort by changed_at (most recent first)', () => {
    it('first row is 2026-06-25 (cc7.2), then 06-20 (cc6.1), then 06-15 (cc8.1)', () => {
      render(<DriftSignalsSection signals={SIGNALS} />);
      const rows = Array.from(
        screen.getByTestId('drift-signals-list').querySelectorAll('li'),
      );
      expect(rows[0]).toHaveAttribute('data-testid', 'drift-signal-soc2-cc7.2');
      expect(rows[1]).toHaveAttribute('data-testid', 'drift-signal-soc2-cc6.1');
      expect(rows[2]).toHaveAttribute('data-testid', 'drift-signal-soc2-cc8.1');
    });
  });

  describe('AC#5 — empty state with green check icon', () => {
    it('renders "No control status changes in last 30 days" + check glyph', () => {
      render(<DriftSignalsSection signals={[]} />);
      expect(
        screen.getByTestId('drift-signals-empty'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('drift-empty-check-icon'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/no control status changes in last 30 days/i),
      ).toBeInTheDocument();
    });
  });

  describe('AC#6/#8 — drift banner when current vs 30d drop > threshold', () => {
    it('renders the banner when score dropped 12 points (default threshold 10)', () => {
      render(
        <DriftSignalsSection
          signals={SIGNALS}
          currentScore={80}
          score_30d_ago={92}
        />,
      );
      const banner = screen.getByTestId('drift-banner');
      expect(banner).toHaveAttribute('role', 'alert');
      expect(banner.textContent).toMatch(
        /Posture dropped 12 points in 30 days/i,
      );
    });

    it('does NOT render the banner when drop is exactly at threshold (strict greater-than)', () => {
      render(
        <DriftSignalsSection
          signals={SIGNALS}
          currentScore={80}
          score_30d_ago={90}
          driftThreshold={10}
        />,
      );
      expect(screen.queryByTestId('drift-banner')).toBeNull();
    });

    it('settings-passed threshold of 5pt makes a 6pt drop trip the banner', () => {
      render(
        <DriftSignalsSection
          signals={SIGNALS}
          currentScore={86}
          score_30d_ago={92}
          driftThreshold={5}
        />,
      );
      expect(screen.getByTestId('drift-banner')).toBeInTheDocument();
    });

    it('no banner when 30d baseline is missing (cannot compute drift)', () => {
      render(<DriftSignalsSection signals={SIGNALS} currentScore={80} />);
      expect(screen.queryByTestId('drift-banner')).toBeNull();
    });

    it('no banner when posture improved (negative drop)', () => {
      render(
        <DriftSignalsSection
          signals={SIGNALS}
          currentScore={95}
          score_30d_ago={85}
        />,
      );
      expect(screen.queryByTestId('drift-banner')).toBeNull();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with signals + banner', async () => {
      const { container } = render(
        <DriftSignalsSection
          signals={SIGNALS}
          currentScore={80}
          score_30d_ago={92}
        />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in the empty state', async () => {
      const { container } = render(<DriftSignalsSection signals={[]} />);
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
