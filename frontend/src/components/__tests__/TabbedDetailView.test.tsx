// Authorized by HUB-1602 (E-FE-3 S2) — TabbedDetailView tests. Covers tab switching
// (click + keyboard), URL deep-link sync (default + custom urlParam), per-tab error
// boundary isolation + reset, lazy render, badge slot, and axe-core a11y.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TabbedDetailView, type TabDef } from '../TabbedDetailView';

afterEach(() => {
  cleanup();
});

const BASE_TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', content: <div>Overview content</div> },
  { id: 'plans', label: 'Plans', content: <div>Plans content</div> },
  { id: 'audit', label: 'Audit', content: <div>Audit content</div> },
];

function SearchProbe() {
  const loc = useLocation();
  return <span data-testid="search">{loc.search}</span>;
}

describe('TabbedDetailView (HUB-1602)', () => {
  describe('AC#1/#2 — renders tab strip with active tab visually distinct', () => {
    it('first tab is active by default when URL has no param', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={BASE_TABS} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('tab-overview')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByTestId('tab-plans')).toHaveAttribute(
        'aria-selected',
        'false',
      );
      expect(screen.getByTestId('tabpanel-overview')).toBeInTheDocument();
    });

    it('respects defaultTab when URL has no param', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={BASE_TABS} defaultTab="plans" />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('tab-plans')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByText('Plans content')).toBeInTheDocument();
    });

    it('renders optional badge next to label', () => {
      const tabs: TabDef[] = [
        ...BASE_TABS.slice(0, 2),
        { ...BASE_TABS[2]!, badge: <span>3</span> },
      ];
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={tabs} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('tab-badge-audit')).toHaveTextContent('3');
    });
  });

  describe('AC#3 — URL deep-link sync', () => {
    it('reads active tab from URL param "tab" by default', () => {
      render(
        <MemoryRouter initialEntries={['/?tab=audit']}>
          <TabbedDetailView tabs={BASE_TABS} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('tab-audit')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByText('Audit content')).toBeInTheDocument();
    });

    it('reads from custom urlParam', () => {
      render(
        <MemoryRouter initialEntries={['/?productTab=plans']}>
          <TabbedDetailView tabs={BASE_TABS} urlParam="productTab" />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('tab-plans')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('click writes the tab id to the URL (replace:true)', () => {
      render(
        <MemoryRouter initialEntries={['/?eventId=r-99']}>
          <TabbedDetailView tabs={BASE_TABS} />
          <SearchProbe />
        </MemoryRouter>,
      );
      act(() => {
        fireEvent.click(screen.getByTestId('tab-plans'));
      });
      const search = screen.getByTestId('search').textContent ?? '';
      expect(search).toContain('tab=plans');
      // Non-tab params preserved (drawer's eventId etc.).
      expect(search).toContain('eventId=r-99');
    });

    it('falls back to first tab when URL param is unrecognized', () => {
      render(
        <MemoryRouter initialEntries={['/?tab=does-not-exist']}>
          <TabbedDetailView tabs={BASE_TABS} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('tab-overview')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  });

  describe('AC#4 — per-tab error boundary', () => {
    function Boom(): React.ReactElement {
      throw new Error('boom');
    }

    it('one throwing tab renders its errorFallback; non-failing tabs unaffected after switch', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const tabs: TabDef[] = [
        {
          id: 'broken',
          label: 'Broken',
          content: <Boom />,
          errorFallback: <div data-testid="custom-fallback">Custom fallback</div>,
        },
        { id: 'ok', label: 'OK', content: <div>OK content</div> },
      ];
      render(
        <MemoryRouter initialEntries={['/?tab=broken']}>
          <TabbedDetailView tabs={tabs} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
      // Switching to the working tab renders its content (boundary reset by key).
      act(() => {
        fireEvent.click(screen.getByTestId('tab-ok'));
      });
      expect(screen.getByText('OK content')).toBeInTheDocument();
      // And switching back to broken re-shows the fallback (boundary catches anew).
      act(() => {
        fireEvent.click(screen.getByTestId('tab-broken'));
      });
      expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
      errSpy.mockRestore();
    });

    it('uses the default fallback message when errorFallback is not provided', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const tabs: TabDef[] = [
        { id: 'broken', label: 'Broken', content: <Boom /> },
        { id: 'ok', label: 'OK', content: <div>OK</div> },
      ];
      render(
        <MemoryRouter initialEntries={['/?tab=broken']}>
          <TabbedDetailView tabs={tabs} />
        </MemoryRouter>,
      );
      expect(
        screen.getByText(/Failed to load this tab/i),
      ).toBeInTheDocument();
      errSpy.mockRestore();
    });
  });

  describe('AC#5 — lazy render: only active tab content is mounted', () => {
    it('inactive tab content is NOT in the DOM', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={BASE_TABS} />
        </MemoryRouter>,
      );
      expect(screen.getByText('Overview content')).toBeInTheDocument();
      expect(screen.queryByText('Plans content')).toBeNull();
      expect(screen.queryByText('Audit content')).toBeNull();
    });

    it('calls function-form content lazily — never invokes inactive tabs', () => {
      const overviewFactory = vi.fn(() => <div>Overview lazy</div>);
      const plansFactory = vi.fn(() => <div>Plans lazy</div>);
      const tabs: TabDef[] = [
        { id: 'overview', label: 'Overview', content: overviewFactory },
        { id: 'plans', label: 'Plans', content: plansFactory },
      ];
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={tabs} />
        </MemoryRouter>,
      );
      expect(overviewFactory).toHaveBeenCalled();
      expect(plansFactory).not.toHaveBeenCalled();
    });
  });

  describe('AC#6 — ARIA + keyboard nav', () => {
    it('tablist + tab + tabpanel roles wired correctly', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={BASE_TABS} ariaLabel="Product detail" />
        </MemoryRouter>,
      );
      const tablist = screen.getByRole('tablist', { name: 'Product detail' });
      expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
      const overviewTab = screen.getByRole('tab', { name: 'Overview' });
      expect(overviewTab).toHaveAttribute('aria-controls', 'tabpanel-overview');
      expect(overviewTab).toHaveAttribute('id', 'tab-overview');
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', 'tab-overview');
    });

    it('only the active tab is in the document tab order (tabIndex=0); others -1', () => {
      render(
        <MemoryRouter initialEntries={['/?tab=plans']}>
          <TabbedDetailView tabs={BASE_TABS} />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('tab-overview')).toHaveAttribute('tabindex', '-1');
      expect(screen.getByTestId('tab-plans')).toHaveAttribute('tabindex', '0');
      expect(screen.getByTestId('tab-audit')).toHaveAttribute('tabindex', '-1');
    });

    it('ArrowRight on the active tab moves selection and focus to the next tab', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={BASE_TABS} />
        </MemoryRouter>,
      );
      const overviewTab = screen.getByTestId('tab-overview');
      overviewTab.focus();
      act(() => {
        fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });
      });
      expect(screen.getByTestId('tab-plans')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('ArrowLeft from the first tab wraps to the last tab', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={BASE_TABS} />
        </MemoryRouter>,
      );
      const overviewTab = screen.getByTestId('tab-overview');
      overviewTab.focus();
      act(() => {
        fireEvent.keyDown(overviewTab, { key: 'ArrowLeft' });
      });
      expect(screen.getByTestId('tab-audit')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('Home jumps to the first tab; End jumps to the last', () => {
      render(
        <MemoryRouter initialEntries={['/?tab=plans']}>
          <TabbedDetailView tabs={BASE_TABS} />
        </MemoryRouter>,
      );
      const plansTab = screen.getByTestId('tab-plans');
      plansTab.focus();
      act(() => {
        fireEvent.keyDown(plansTab, { key: 'End' });
      });
      expect(screen.getByTestId('tab-audit')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      act(() => {
        fireEvent.keyDown(screen.getByTestId('tab-audit'), { key: 'Home' });
      });
      expect(screen.getByTestId('tab-overview')).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  });

  describe('edge cases', () => {
    it('renders an empty-state message when tabs array is empty', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={[]} />
        </MemoryRouter>,
      );
      expect(screen.getByText(/no tabs to display/i)).toBeInTheDocument();
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe scan with the default-tab state', async () => {
      const { container } = render(
        <MemoryRouter initialEntries={['/']}>
          <TabbedDetailView tabs={BASE_TABS} ariaLabel="Product detail" />
        </MemoryRouter>,
      );
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
