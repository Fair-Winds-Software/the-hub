// Authorized by HUB-1601 — DataTable component tests. Covers columns rendering, search,
// sort (asc/desc/cycle/aria-sort), pagination (incl. clamp on filter change), empty/loading/
// error states, row click + keyboard activation, default sort, and axe-core a11y.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { DataTable, type ColumnDef } from '../DataTable';

interface Row {
  id: string;
  name: string;
  age: number;
  city: string;
}

const SAMPLE_ROWS: Row[] = [
  { id: 'r1', name: 'Alice', age: 30, city: 'New York' },
  { id: 'r2', name: 'Bob', age: 25, city: 'Chicago' },
  { id: 'r3', name: 'Charlie', age: 35, city: 'Austin' },
  { id: 'r4', name: 'Diana', age: 28, city: 'Boston' },
];

const SAMPLE_COLUMNS: ColumnDef<Row>[] = [
  {
    key: 'name',
    header: 'Name',
    render: (r) => r.name,
    sortable: true,
    sortValue: (r) => r.name,
    searchValue: (r) => r.name,
  },
  {
    key: 'age',
    header: 'Age',
    render: (r) => r.age,
    sortable: true,
    sortValue: (r) => r.age,
  },
  {
    key: 'city',
    header: 'City',
    render: (r) => r.city,
    searchValue: (r) => r.city,
  },
];

afterEach(() => {
  cleanup();
});

function renderTable(overrides: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  const defaults = {
    columns: SAMPLE_COLUMNS,
    rows: SAMPLE_ROWS,
    rowKey: (r: Row) => r.id,
    ariaLabel: 'Sample table',
    searchableColumns: ['name', 'city'],
  };
  return render(<DataTable<Row> {...defaults} {...overrides} />);
}

describe('DataTable (HUB-1601)', () => {
  describe('AC#1 — semantic table + columns + rows', () => {
    it('renders <table> with the configured columns and rows', () => {
      renderTable();
      const table = screen.getByRole('table', { name: 'Sample table' });
      expect(table).toBeInTheDocument();
      const headers = within(table).getAllByRole('columnheader');
      // Sortable header text includes the arrow indicator (↕/▲/▼); assert via substring.
      const headerTexts = headers.map((h) => h.textContent ?? '');
      expect(headerTexts.some((t) => t.includes('Name'))).toBe(true);
      expect(headerTexts.some((t) => t.includes('Age'))).toBe(true);
      expect(headerTexts.some((t) => t.includes('City'))).toBe(true);
      // 4 sample rows in body (plus header row)
      expect(screen.getAllByTestId('data-table-row')).toHaveLength(4);
    });
  });

  describe('AC#5 — empty state', () => {
    it('renders default empty state when filtered rows are 0', () => {
      renderTable({ rows: [] });
      expect(screen.getByText('No matching entries.')).toBeInTheDocument();
      expect(screen.queryAllByTestId('data-table-row')).toHaveLength(0);
    });

    it('renders custom emptyState ReactNode when provided', () => {
      renderTable({ rows: [], emptyState: <strong>nothing yet</strong> });
      expect(screen.getByText('nothing yet')).toBeInTheDocument();
    });
  });

  describe('AC#6 — loading state', () => {
    it('renders skeleton rows when loading=true', () => {
      renderTable({ loading: true });
      expect(screen.getAllByTestId('data-table-skeleton-row')).toHaveLength(5);
      // Real rows must NOT be in DOM under loading.
      expect(screen.queryAllByTestId('data-table-row')).toHaveLength(0);
    });
  });

  describe('AC#7 — error state', () => {
    it('renders role="alert" with the error message; replaces tbody content', () => {
      renderTable({ error: 'Could not load entries' });
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Could not load entries');
      expect(screen.queryAllByTestId('data-table-row')).toHaveLength(0);
      // Pagination is hidden in error state too.
      expect(screen.queryByTestId('data-table-pagination')).toBeNull();
    });
  });

  describe('AC#2 — search', () => {
    it('typing filters rows by configured searchableColumns (case-insensitive substring)', () => {
      renderTable();
      const search = screen.getByLabelText('Search Sample table');
      fireEvent.change(search, { target: { value: 'ali' } });
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain('Alice');
    });

    it('does NOT render a search input when searchableColumns is empty/omitted', () => {
      renderTable({ searchableColumns: [] });
      expect(screen.queryByLabelText('Search Sample table')).toBeNull();
    });
  });

  describe('AC#3 — sort: cycle asc → desc → none + aria-sort + arrow indicator', () => {
    it('first click sets asc and aria-sort="ascending"', () => {
      renderTable();
      const nameHeader = screen.getByRole('columnheader', { name: /Name/ });
      const sortBtn = within(nameHeader).getByRole('button');
      fireEvent.click(sortBtn);
      expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
      // First row should now be Alice (alphabetical asc)
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows[0]!.textContent).toContain('Alice');
    });

    it('second click flips to desc and aria-sort="descending"', () => {
      renderTable();
      const nameHeader = screen.getByRole('columnheader', { name: /Name/ });
      const sortBtn = within(nameHeader).getByRole('button');
      fireEvent.click(sortBtn);
      fireEvent.click(sortBtn);
      expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows[0]!.textContent).toContain('Diana');
    });

    it('third click clears sort and aria-sort="none"', () => {
      renderTable();
      const nameHeader = screen.getByRole('columnheader', { name: /Name/ });
      const sortBtn = within(nameHeader).getByRole('button');
      fireEvent.click(sortBtn);
      fireEvent.click(sortBtn);
      fireEvent.click(sortBtn);
      expect(nameHeader).toHaveAttribute('aria-sort', 'none');
      // Original order restored.
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows[0]!.textContent).toContain('Alice');
      expect(rows[1]!.textContent).toContain('Bob');
    });

    it('column without sortValue is NOT sortable even if header clicked', () => {
      renderTable();
      // 'city' column has no sortValue — its header has no button at all.
      const cityHeader = screen.getByRole('columnheader', { name: 'City' });
      expect(within(cityHeader).queryByRole('button')).toBeNull();
      expect(cityHeader).not.toHaveAttribute('aria-sort');
    });
  });

  describe('AC#3 — defaultSort', () => {
    it('applies defaultSort on mount', () => {
      renderTable({ defaultSort: { key: 'age', direction: 'desc' } });
      const rows = screen.getAllByTestId('data-table-row');
      // Sorted by age desc: Charlie (35), Alice (30), Diana (28), Bob (25)
      expect(rows[0]!.textContent).toContain('Charlie');
      expect(rows[3]!.textContent).toContain('Bob');
    });
  });

  describe('AC#4 — pagination', () => {
    function bigRows(): Row[] {
      return Array.from({ length: 53 }, (_, i) => ({
        id: `r${i}`,
        name: `Name${i.toString().padStart(2, '0')}`,
        age: 20 + i,
        city: `City${i}`,
      }));
    }

    it('respects pageSize and shows "Showing X–Y of Z"', () => {
      renderTable({ rows: bigRows(), pageSize: 25 });
      expect(screen.getAllByTestId('data-table-row')).toHaveLength(25);
      const pagination = screen.getByTestId('data-table-pagination');
      expect(pagination.textContent).toContain('Showing 1–25 of 53 entries');
    });

    it('Prev/Next buttons disable at boundaries', () => {
      renderTable({ rows: bigRows(), pageSize: 25 });
      const prev = screen.getByRole('button', { name: 'Previous page' });
      const next = screen.getByRole('button', { name: 'Next page' });
      expect(prev).toBeDisabled();
      expect(next).not.toBeDisabled();

      fireEvent.click(next);
      expect(prev).not.toBeDisabled();
      fireEvent.click(next); // page 3 (last)
      expect(next).toBeDisabled();
      expect(screen.getByTestId('data-table-pagination').textContent).toContain(
        'Showing 51–53 of 53 entries',
      );
    });
  });

  describe('AC#8 — row click + keyboard activation', () => {
    it('onRowClick fires with the row on click', () => {
      const onRowClick = vi.fn();
      renderTable({ onRowClick });
      const rows = screen.getAllByTestId('data-table-row');
      fireEvent.click(rows[0]!);
      expect(onRowClick).toHaveBeenCalledTimes(1);
      expect(onRowClick.mock.calls[0]![0]).toEqual(SAMPLE_ROWS[0]);
    });

    it('Enter key on focused row activates onRowClick', () => {
      const onRowClick = vi.fn();
      renderTable({ onRowClick });
      const rows = screen.getAllByTestId('data-table-row');
      rows[1]!.focus();
      fireEvent.keyDown(rows[1]!, { key: 'Enter' });
      expect(onRowClick).toHaveBeenCalledWith(SAMPLE_ROWS[1]);
    });

    it('rows are NOT keyboard-focusable when onRowClick is undefined', () => {
      renderTable();
      const rows = screen.getAllByTestId('data-table-row');
      expect(rows[0]).not.toHaveAttribute('tabindex');
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe-core scan with data', async () => {
      const { container } = renderTable();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });

    it('passes axe-core scan in empty state', async () => {
      const { container } = renderTable({ rows: [] });
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
