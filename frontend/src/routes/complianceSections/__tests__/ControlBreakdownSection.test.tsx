// Authorized by HUB-1626 (E-FE-8 S7) — ControlBreakdownSection tests. Covers
// section wrapper, 6-column header, status verdict cell (color+icon+text),
// evidence link with target=_blank + rel=noopener noreferrer, empty state
// with Settings CTA, default failing-first sort, and axe-core.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import {
  ControlBreakdownSection,
  type ControlRow,
} from '../ControlBreakdownSection';

afterEach(() => {
  cleanup();
});

const CONTROLS: ControlRow[] = [
  {
    control_id: 'CC6.1',
    framework: 'SOC 2',
    control_name: 'Logical access controls',
    status: 'failing',
    last_evaluated_at: '2026-06-25T12:00:00.000Z',
    evidence_url: 'https://evidence.example.com/cc6.1',
  },
  {
    control_id: 'CC7.2',
    framework: 'SOC 2',
    control_name: 'Threat detection',
    status: 'warning',
    last_evaluated_at: '2026-06-20T12:00:00.000Z',
    evidence_url: null,
  },
  {
    control_id: 'A.5.1',
    framework: 'ISO 27001',
    control_name: 'Information security policies',
    status: 'passing',
    last_evaluated_at: '2026-06-15T12:00:00.000Z',
  },
];

function renderSection(controls: ControlRow[] = CONTROLS) {
  return render(
    <MemoryRouter>
      <ControlBreakdownSection controls={controls} />
    </MemoryRouter>,
  );
}

describe('ControlBreakdownSection (HUB-1626)', () => {
  describe('AC#1 — section wrapper', () => {
    it('renders <section aria-labelledby> with "Per-Control Breakdown" heading', () => {
      renderSection();
      const section = screen.getByTestId('compliance-section-per-control');
      expect(section).toHaveAttribute(
        'aria-labelledby',
        'control-breakdown-heading',
      );
      expect(
        screen.getByRole('heading', { name: 'Per-Control Breakdown' }),
      ).toBeInTheDocument();
    });
  });

  describe('AC#2 — 6 column headers', () => {
    it('renders Control ID / Framework / Control Name / Status / Last Evaluated / Evidence', () => {
      renderSection();
      const table = screen.getByRole('table', {
        name: 'Per-control compliance breakdown',
      });
      const headers = Array.from(table.querySelectorAll('th')).map(
        (h) => h.textContent ?? '',
      );
      for (const label of [
        'Control ID',
        'Framework',
        'Control Name',
        'Status',
        'Last Evaluated',
        'Evidence',
      ]) {
        expect(headers.some((h) => h.includes(label))).toBe(true);
      }
    });
  });

  describe('AC#5 — Status verdict color + icon + text triple-encoded (a11y floor)', () => {
    it.each(['passing', 'warning', 'failing'] as const)(
      'status=%s renders an icon AND a visible status text label',
      (status) => {
        const row: ControlRow = {
          control_id: `ctl-${status}`,
          framework: 'SOC 2',
          control_name: 'sample',
          status,
          last_evaluated_at: '2026-06-01T00:00:00.000Z',
        };
        renderSection([row]);
        expect(
          screen.getByTestId(`control-status-icon-${status}`),
        ).toBeInTheDocument();
        const cell = screen.getByTestId(`control-status-${status}`);
        expect(cell.textContent).toContain(status);
      },
    );
  });

  describe('AC#6 — evidence link opens in new tab; empty cell shows em-dash', () => {
    it('row with evidence_url renders <a target=_blank rel=noopener noreferrer>', () => {
      renderSection();
      const link = screen.getByTestId('control-evidence-link-CC6.1');
      expect(link).toHaveAttribute(
        'href',
        'https://evidence.example.com/cc6.1',
      );
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.getAttribute('aria-label')).toMatch(
        /Evidence for CC6\.1 \(opens in a new tab\)/,
      );
    });

    it('row with null evidence_url renders an em-dash', () => {
      renderSection();
      expect(
        screen.getByTestId('control-evidence-empty-CC7.2').textContent,
      ).toBe('—');
    });

    it('row with undefined evidence_url renders an em-dash', () => {
      renderSection();
      // A.5.1 has no evidence_url in the fixture.
      expect(
        screen.getByTestId('control-evidence-empty-A.5.1'),
      ).toBeInTheDocument();
    });
  });

  describe('AC#9 — default sort is failing-first (Status asc)', () => {
    it('first visible row is the failing control (CC6.1), then warning (CC7.2), then passing (A.5.1)', () => {
      renderSection();
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows[0]!.textContent).toContain('CC6.1');
      expect(rows[1]!.textContent).toContain('CC7.2');
      expect(rows[2]!.textContent).toContain('A.5.1');
    });
  });

  describe('AC#7 — empty state with Settings CTA', () => {
    it('renders "No controls configured for this product" + Settings link', () => {
      renderSection([]);
      expect(
        screen.getByTestId('control-breakdown-empty-state'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('control-breakdown-empty-cta'),
      ).toHaveAttribute('href', '/console/settings');
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with rows loaded', async () => {
      const { container } = renderSection();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe scan in empty state', async () => {
      const { container } = renderSection([]);
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
