// Authorized by HUB-1614 (E-FE-12 S4) — AuditResultTable tests. Covers the 6-column
// contract, default sort (Timestamp desc), loading + empty + error states, the
// "Showing X of N" summary above the table (AC#4), row click pass-through (S5 wiring),
// and axe-core a11y.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { AuditResultTable } from '../AuditResultTable';
import type { AuditRow } from '../AuditFilters';

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 'r1',
    operator_id: 'op-1',
    entity_type: 'products',
    entity_id: 'p-1',
    action: 'update',
    before_value: null,
    after_value: null,
    notes: null,
    tenant_id: '00000000-0000-0000-0000-0000000000a1',
    product_id: 'p-1',
    recommendation_id: null,
    created_at: '2026-06-15T12:00:00.000Z',
    ...overrides,
  };
}

const SAMPLE_ROWS: AuditRow[] = [
  row({ id: 'r1', action: 'create', created_at: '2026-06-01T00:00:00.000Z' }),
  row({ id: 'r2', action: 'update', created_at: '2026-06-15T00:00:00.000Z' }),
  row({ id: 'r3', action: 'delete', created_at: '2026-06-10T00:00:00.000Z' }),
];

afterEach(() => {
  cleanup();
});

describe('AuditResultTable (HUB-1614)', () => {
  describe('AC#1 — 6 columns rendered', () => {
    it('renders Timestamp, Actor, Action, Entity Type, Entity ID, Detail headers', () => {
      render(
        <AuditResultTable rows={SAMPLE_ROWS} total={3} loading={false} error={null} />,
      );
      const table = screen.getByRole('table', { name: 'Audit log entries' });
      const headerTexts = within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent ?? '');
      for (const label of [
        'Timestamp',
        'Actor',
        'Action',
        'Entity Type',
        'Entity ID',
        'Detail',
      ]) {
        expect(headerTexts.some((t) => t.includes(label))).toBe(true);
      }
    });
  });

  describe('AC#9 — default sort is Timestamp desc', () => {
    it('aria-sort="descending" on Timestamp header on initial render', () => {
      render(
        <AuditResultTable rows={SAMPLE_ROWS} total={3} loading={false} error={null} />,
      );
      const timestampHeader = screen.getByRole('columnheader', { name: /Timestamp/ });
      expect(timestampHeader).toHaveAttribute('aria-sort', 'descending');
    });

    it('first row is the most recent (2026-06-15)', () => {
      render(
        <AuditResultTable rows={SAMPLE_ROWS} total={3} loading={false} error={null} />,
      );
      const tableRows = screen.getAllByTestId('data-table-row');
      // SAMPLE_ROWS[1] has 2026-06-15 (the latest)
      expect(tableRows[0]!.textContent).toContain('update');
    });
  });

  describe('AC#5 — loading state passes through to DataTable skeleton', () => {
    it('renders DataTable skeleton rows when loading=true', () => {
      render(<AuditResultTable rows={null} total={0} loading={true} error={null} />);
      expect(screen.getAllByTestId('data-table-skeleton-row')).toHaveLength(5);
      expect(screen.queryAllByTestId('data-table-row')).toHaveLength(0);
    });

    it('shows loading summary line above the table', () => {
      render(<AuditResultTable rows={null} total={0} loading={true} error={null} />);
      expect(screen.getByTestId('audit-summary-loading')).toBeInTheDocument();
    });
  });

  describe('AC#6 — empty state with spec text', () => {
    it('renders "No matching audit entries — try widening your filters." when rows is an empty array', () => {
      render(<AuditResultTable rows={[]} total={0} loading={false} error={null} />);
      // The exact spec wording appears in the DataTable's emptyState slot.
      expect(
        screen.getByText(
          /No matching audit entries — try widening your filters\./,
        ),
      ).toBeInTheDocument();
    });
  });

  describe('AC#7 — error banner above the table with Reset-filters guidance', () => {
    it('renders role="alert" banner with the error message', () => {
      render(
        <AuditResultTable rows={null} total={0} loading={false} error="Network down" />,
      );
      const banner = screen.getByTestId('audit-error-banner');
      expect(banner).toBeInTheDocument();
      expect(banner.textContent).toContain('Could not load audit entries.');
      expect(banner.textContent).toContain('Network down');
      // Reset-filters guidance (spec deviation #1) — points operators at the existing
      // AuditFilters Reset button rather than a separate Retry button.
      expect(banner.textContent).toMatch(/Reset filters/);
      // Error is still tagged via role="alert".
      expect(screen.getByRole('alert')).toBe(banner);
    });

    it('summary line is suppressed when error is set (banner replaces it)', () => {
      render(
        <AuditResultTable rows={null} total={0} loading={false} error="Boom" />,
      );
      expect(screen.queryByTestId('audit-summary-count')).toBeNull();
      expect(screen.queryByTestId('audit-summary-loading')).toBeNull();
    });
  });

  describe('AC#4 — "Showing N of T" summary above the table', () => {
    it('renders "Showing N of T entries" when rows have loaded', () => {
      render(
        <AuditResultTable rows={SAMPLE_ROWS} total={42} loading={false} error={null} />,
      );
      const summary = screen.getByTestId('audit-summary-count');
      expect(summary.textContent).toBe('Showing 3 of 42 entries');
    });
  });

  describe('AC#8 — onRowClick passes through to DataTable', () => {
    it('row click invokes onRowClick with the full row', () => {
      const onRowClick = vi.fn();
      render(
        <AuditResultTable
          rows={SAMPLE_ROWS}
          total={3}
          loading={false}
          error={null}
          onRowClick={onRowClick}
        />,
      );
      const rows = screen.getAllByTestId('data-table-row');
      fireEvent.click(rows[0]!);
      expect(onRowClick).toHaveBeenCalledTimes(1);
      // Default sort is timestamp desc, so the first row is the latest (2026-06-15 update).
      expect(onRowClick.mock.calls[0]![0].id).toBe('r2');
    });
  });

  describe('Detail column — 80-char truncation', () => {
    it('renders compact preview when payload is small', () => {
      render(
        <AuditResultTable
          rows={[row({ notes: 'hi' })]}
          total={1}
          loading={false}
          error={null}
        />,
      );
      // Compact JSON: {"notes":"hi"}
      expect(screen.getByText('{"notes":"hi"}')).toBeInTheDocument();
    });

    it('truncates with "…" when JSON exceeds 80 chars', () => {
      const longNotes = 'x'.repeat(200);
      render(
        <AuditResultTable
          rows={[row({ notes: longNotes })]}
          total={1}
          loading={false}
          error={null}
        />,
      );
      const cells = screen
        .getAllByTestId('data-table-row')[0]!
        .querySelectorAll('td');
      const detailCell = cells[cells.length - 1]!;
      expect(detailCell.textContent!.length).toBe(80);
      expect(detailCell.textContent!.endsWith('…')).toBe(true);
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe-core scan with rows', async () => {
      const { container } = render(
        <AuditResultTable rows={SAMPLE_ROWS} total={3} loading={false} error={null} />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe-core scan in error state', async () => {
      const { container } = render(
        <AuditResultTable rows={null} total={0} loading={false} error="boom" />,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
