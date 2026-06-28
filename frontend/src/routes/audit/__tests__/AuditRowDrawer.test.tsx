// Authorized by HUB-1615 (E-FE-12 S5) — AuditRowDrawer tests. Covers open/close lifecycle,
// the formatted header + fields, JSON pretty-print, copy-to-clipboard with toast feedback,
// the eventId permalink anchor (S6 deep-link pre-wiring), and axe-core a11y.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { MemoryRouter } from 'react-router-dom';
import { AuditRowDrawer } from '../AuditRowDrawer';
import { useToastStore } from '../../../stores/toastStore';
import type { AuditRow } from '../AuditFilters';

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 'r-abc-123',
    operator_id: 'op-1',
    entity_type: 'products',
    entity_id: 'p-xyz-789',
    action: 'update',
    before_value: { name: 'old' },
    after_value: { name: 'new' },
    notes: 'rename via console',
    tenant_id: '00000000-0000-0000-0000-0000000000a1',
    product_id: 'p-xyz-789',
    recommendation_id: null,
    created_at: '2026-06-21T14:32:11.000Z',
    ...overrides,
  };
}

function renderDrawer(props: Partial<React.ComponentProps<typeof AuditRowDrawer>> = {}) {
  const defaults = {
    row: row(),
    onClose: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <AuditRowDrawer {...defaults} {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Reset toast store between tests so toast assertions are isolated.
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
});

describe('AuditRowDrawer (HUB-1615)', () => {
  describe('AC#1 — open/close lifecycle', () => {
    it('renders the SideDrawer when row is set', () => {
      renderDrawer();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('renders nothing when row is null', () => {
      renderDrawer({ row: null });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('Escape key triggers onClose', () => {
      const onClose = vi.fn();
      renderDrawer({ onClose });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('AC#2 — header shows action + entity type + timestamp', () => {
    it('drawer title shows action · entity_type', () => {
      renderDrawer();
      const dialog = screen.getByRole('dialog');
      // The title is rendered as the labelled heading by SideDrawer.
      const headingId = dialog.getAttribute('aria-labelledby')!;
      expect(document.getElementById(headingId)?.textContent).toBe('update · products');
    });

    it('header line shows action · entity_type · ISO timestamp + UTC suffix', () => {
      renderDrawer();
      expect(
        screen.getByText(/update · products · 2026-06-21 14:32:11 UTC/),
      ).toBeInTheDocument();
    });
  });

  describe('AC#3 — body fields', () => {
    it('renders Actor / Action / Entity Type / Entity ID', () => {
      renderDrawer();
      expect(screen.getByText('Actor')).toBeInTheDocument();
      expect(screen.getByTestId('row-actor').textContent).toBe('op-1');
      expect(screen.getByText('Action')).toBeInTheDocument();
      expect(screen.getByText('Entity Type')).toBeInTheDocument();
      expect(screen.getByText('Entity ID')).toBeInTheDocument();
      expect(screen.getByTestId('row-entity-id').textContent).toBe('p-xyz-789');
    });

    it('shows "system" placeholder when operator_id is null', () => {
      renderDrawer({ row: row({ operator_id: null }) });
      expect(screen.getByTestId('row-actor').textContent).toBe('system');
    });

    it('Detail JSON pretty-printed with 2-space indent in a <pre>', () => {
      renderDrawer();
      const pre = screen.getByTestId('row-detail-json');
      expect(pre.tagName).toBe('PRE');
      // The exact text content reflects JSON.stringify with 2-space indent.
      expect(pre.textContent).toContain('"notes": "rename via console"');
      expect(pre.textContent).toContain('"before_value"');
      expect(pre.textContent).toContain('"after_value"');
    });
  });

  describe('AC#4 — "Open in new tab" link to /console/audit?eventId=...', () => {
    it('anchor href points to the eventId deep-link (S6 wiring lands HUB-1616)', () => {
      renderDrawer();
      const link = screen.getByTestId('row-permalink') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe(
        '/console/audit?eventId=r-abc-123',
      );
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('encodes special characters in the eventId', () => {
      renderDrawer({ row: row({ id: 'r/with spaces&chars' }) });
      const link = screen.getByTestId('row-permalink') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe(
        '/console/audit?eventId=r%2Fwith%20spaces%26chars',
      );
    });
  });

  describe('AC#7 — Copy-to-clipboard with success toast', () => {
    it('clicking Copy calls clipboard.writeText with entity_id + fires success toast', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      renderDrawer();
      fireEvent.click(screen.getByRole('button', { name: 'Copy Entity ID' }));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('p-xyz-789');
      });
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => t.message === 'Entity ID copied')).toBe(true);
      expect(toasts.some((t) => t.variant === 'success')).toBe(true);
    });

    it('falls back to warning toast when clipboard API unavailable (spec deviation #2)', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
      });
      renderDrawer();
      fireEvent.click(screen.getByRole('button', { name: 'Copy Entity ID' }));
      await waitFor(() => {
        const toasts = useToastStore.getState().toasts;
        expect(toasts.some((t) => t.variant === 'warning')).toBe(true);
      });
    });

    it('surfaces error toast when clipboard.writeText rejects', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      renderDrawer();
      fireEvent.click(screen.getByRole('button', { name: 'Copy Entity ID' }));
      await waitFor(() => {
        const toasts = useToastStore.getState().toasts;
        expect(toasts.some((t) => t.variant === 'error')).toBe(true);
      });
    });
  });

  describe('a11y — axe-core zero violations', () => {
    it('passes axe-core scan when open', async () => {
      const { container } = renderDrawer();
      const results = await axe(container);
      expect(results.violations).toEqual([]);
    });
  });
});
