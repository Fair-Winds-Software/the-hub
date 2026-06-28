// Authorized by HUB-1612 (E-FE-12 S2) — Audit route scaffold tests. Covers structural
// landmarks (sidebar + main), document.title management, placeholder slots (mount points
// for HUB-1613 S3 + HUB-1614 S4), and axe-core a11y on the page shell.
// Updated for HUB-1613 (E-FE-12 S3) — page now wires AuditFilters into the sidebar slot
// and AuditFilters fires fetches on mount. apiClient is mocked here so the page-level
// scaffolding test remains fast + deterministic; AuditFilters' own fetch behavior is
// covered in its dedicated test file.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { axe } from 'vitest-axe';
import Audit from '../Audit';

// Stub apiClient at the module boundary — AuditFilters' mount-time fetches go through it.
// Reject with a never-resolving promise so the page stays in its initial "rows=null"
// state for the duration of each test (no async leaks, no flake).
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: vi.fn().mockReturnValue(new Promise(() => {})),
  },
}));

afterEach(() => {
  cleanup();
});

describe('Audit (HUB-1612 — /console/audit page scaffold)', () => {
  describe('AC#2/3/4 — 2-col layout with placeholder slots', () => {
    it('renders sidebar landmark + main landmark with placeholder slots', () => {
      render(<Audit />);

      // Sidebar landmark with the required aria-label.
      const sidebar = screen.getByRole('complementary', { name: 'Audit filters' });
      expect(sidebar).toBeInTheDocument();
      expect(sidebar).toHaveAttribute('data-testid', 'audit-filter-sidebar');

      // Main landmark with id="main-content" (matches ConsoleShell convention).
      const main = screen.getByRole('main');
      expect(main).toBeInTheDocument();
      expect(main).toHaveAttribute('id', 'main-content');
      expect(main).toHaveAttribute('data-testid', 'audit-main');
    });

    it('renders an h1 page heading "Audit Log"', () => {
      render(<Audit />);
      expect(
        screen.getByRole('heading', { level: 1, name: 'Audit Log' }),
      ).toBeInTheDocument();
    });

    it('sidebar embeds the AuditFilters form; main embeds the AuditResultTable', () => {
      render(<Audit />);
      // Sidebar slot — AuditFilters form rendered (HUB-1613)
      expect(
        screen.getByRole('form', { name: 'Audit log filters' }),
      ).toBeInTheDocument();
      // Main slot — AuditResultTable rendered (HUB-1614); the inner DataTable surfaces a
      // <table> with aria-label="Audit log entries".
      expect(screen.getByTestId('audit-result-table')).toBeInTheDocument();
      expect(
        screen.getByRole('table', { name: 'Audit log entries' }),
      ).toBeInTheDocument();
    });
  });

  describe('AC#5 — document.title management', () => {
    it('sets document.title to "Audit Log | HUB Console" on mount', () => {
      const original = document.title;
      try {
        document.title = 'Some other title';
        render(<Audit />);
        expect(document.title).toBe('Audit Log | HUB Console');
      } finally {
        document.title = original;
      }
    });

    it('restores the previous document.title on unmount', () => {
      const original = document.title;
      try {
        document.title = 'Before audit';
        const { unmount } = render(<Audit />);
        expect(document.title).toBe('Audit Log | HUB Console');
        unmount();
        expect(document.title).toBe('Before audit');
      } finally {
        document.title = original;
      }
    });
  });

  describe('AC#8 — responsive layout (Tailwind utility classes)', () => {
    it('container uses flex-col by default and lg:flex-row at ≥1024px', () => {
      const { container } = render(<Audit />);
      const root = container.firstElementChild as HTMLElement;
      expect(root.className).toMatch(/flex-col/);
      expect(root.className).toMatch(/lg:flex-row/);
    });

    it('sidebar has fixed 280px width at ≥1024px', () => {
      render(<Audit />);
      const sidebar = screen.getByTestId('audit-filter-sidebar');
      // Tailwind lg:w-[280px] arbitrary-value class — string check is enough; jsdom does
      // not resolve viewport-conditional CSS.
      expect(sidebar.className).toMatch(/lg:w-\[280px\]/);
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe-core scan on the page shell', async () => {
      const { container } = render(<Audit />);
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
