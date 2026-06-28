// Authorized by HUB-1612 (E-FE-12 S2) — Audit route scaffold tests. Covers structural
// landmarks (sidebar + main), document.title management, placeholder slots (mount points
// for HUB-1613 S3 + HUB-1614 S4), and axe-core a11y on the page shell.
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { axe } from 'vitest-axe';
import Audit from '../Audit';

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

    it('placeholder content present in both slots (mount points for S3 + S4)', () => {
      render(<Audit />);
      // Sidebar slot — filter placeholder
      expect(screen.getByText(/Filters/)).toBeInTheDocument();
      expect(screen.getByText(/HUB-1613/)).toBeInTheDocument();
      // Main slot — table placeholder
      expect(screen.getByText(/HUB-1614/)).toBeInTheDocument();
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
