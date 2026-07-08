// Authorized by HUB-1766/1767 (E-V2-PP-5 S7/S8, HUB-1729, HUB-1701) —
// unit tests for QuotaSubUnlockEditor + QuarterlyCycleWidget.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  QuotaSubUnlockEditor,
  validateQuotaSubUnlocks,
  draftToSubmit,
} from '../productDetail/QuotaSubUnlockEditor';
import { QuarterlyCycleWidget } from '../QuarterlyCycleWidget';

const apiGetMock = vi.fn();
vi.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

beforeEach(() => apiGetMock.mockReset());
afterEach(() => cleanup());

// ── HUB-1766 (S7): QuotaSubUnlockEditor + validator ────────────────────────
describe('HUB-1766 (S7): validateQuotaSubUnlocks', () => {
  it('accepts a valid single row', () => {
    expect(validateQuotaSubUnlocks([{ dimension_key: 'content_pieces', per_month_quantity: '10' }])).toEqual({});
  });
  it('rejects empty dimension_key', () => {
    expect(validateQuotaSubUnlocks([{ dimension_key: '', per_month_quantity: '10' }]))
      .toHaveProperty('0.dimension_key');
  });
  it('rejects non-snake-case dimension_key', () => {
    expect(validateQuotaSubUnlocks([{ dimension_key: 'ContentPieces', per_month_quantity: '10' }]))
      .toHaveProperty('0.dimension_key');
  });
  it('rejects per_month_quantity < 1', () => {
    expect(validateQuotaSubUnlocks([{ dimension_key: 'content_pieces', per_month_quantity: '0' }]))
      .toHaveProperty('0.per_month_quantity');
  });
  it('rejects duplicate dimension_key', () => {
    const errors = validateQuotaSubUnlocks([
      { dimension_key: 'content_pieces', per_month_quantity: '10' },
      { dimension_key: 'content_pieces', per_month_quantity: '20' },
    ]);
    expect(errors).toHaveProperty('1.dimension_key');
  });
});

describe('draftToSubmit', () => {
  it('converts strings to submit payload', () => {
    expect(draftToSubmit([{ dimension_key: '  content_pieces  ', per_month_quantity: '10' }]))
      .toEqual([{ dimension_key: 'content_pieces', per_month_quantity: 10 }]);
  });
});

describe('HUB-1766 (S7): QuotaSubUnlockEditor', () => {
  it('shows empty state initially', () => {
    render(<QuotaSubUnlockEditor onChange={() => {}} />);
    expect(screen.getByTestId('quota-sub-unlock-empty')).toBeInTheDocument();
  });

  it('renders initial rows', () => {
    render(
      <QuotaSubUnlockEditor
        initial={[{ dimension_key: 'content_pieces', per_month_quantity: 10 }]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('quota-sub-unlock-row-0')).toBeInTheDocument();
    expect((screen.getByTestId('quota-sub-unlock-key-0') as HTMLInputElement).value).toBe('content_pieces');
  });

  it('adds a row on button click and notifies onChange', () => {
    const onChange = vi.fn();
    render(<QuotaSubUnlockEditor onChange={onChange} />);
    fireEvent.click(screen.getByTestId('quota-sub-unlock-add'));
    expect(onChange).toHaveBeenCalledWith([{ dimension_key: '', per_month_quantity: '' }]);
    expect(screen.getByTestId('quota-sub-unlock-row-0')).toBeInTheDocument();
  });

  it('removes a row on remove button click', () => {
    render(
      <QuotaSubUnlockEditor
        initial={[
          { dimension_key: 'content_pieces', per_month_quantity: 10 },
          { dimension_key: 'brand_assets', per_month_quantity: 5 },
        ]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('quota-sub-unlock-remove-0'));
    expect(screen.queryByTestId('quota-sub-unlock-row-1')).toBeNull();
  });

  it('surfaces per-row validation errors inline', () => {
    render(
      <QuotaSubUnlockEditor
        initial={[{ dimension_key: 'BadKey', per_month_quantity: 5 }]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('quota-sub-unlock-key-err-0')).toBeInTheDocument();
  });
});

// ── HUB-1767 (S8): QuarterlyCycleWidget ────────────────────────────────────
describe('HUB-1767 (S8): QuarterlyCycleWidget', () => {
  const PREVIEW = {
    preview: {
      cycle: {
        cycle_id: 'c1', cycle_start: '2026-01-01', cycle_end: '2026-04-01',
        cycle_position: 2 as const, month_start: '2026-02-01', month_end: '2026-03-01',
        days_remaining_in_cycle: 45, days_until_next_unlock: 28,
      },
      dimensions: [
        { dimension_key: 'content_pieces', per_month_quantity: 10, total_this_cycle: 30, unlocked_to_date: 20 },
      ],
    },
  };

  it('renders position + date range', async () => {
    apiGetMock.mockResolvedValue(PREVIEW);
    render(<QuarterlyCycleWidget tenantId="t1" planId="p1" />);
    await waitFor(() => expect(screen.getByTestId('quarterly-cycle-widget')).toBeInTheDocument());
    expect(screen.getByTestId('quarterly-cycle-position').textContent).toContain('Month 2 of 3');
    expect(screen.getByTestId('quarterly-cycle-dim-content_pieces')).toBeInTheDocument();
  });

  it('renders nothing when no preview returned (non-quarterly plan)', async () => {
    apiGetMock.mockResolvedValue({ preview: null });
    const { container } = render(<QuarterlyCycleWidget tenantId="t1" planId="p1" />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="quarterly-cycle-widget"]')).toBeNull();
  });

  it('shows imminent-unlock badge when days_until_next_unlock <= 1', async () => {
    apiGetMock.mockResolvedValue({
      preview: { ...PREVIEW.preview, cycle: { ...PREVIEW.preview.cycle, days_until_next_unlock: 0 } },
    });
    render(<QuarterlyCycleWidget tenantId="t1" planId="p1" />);
    await waitFor(() => expect(screen.getByTestId('quarterly-cycle-next-unlock-imminent')).toBeInTheDocument());
  });

  it('bar renders warning color when consumed > 80%', async () => {
    apiGetMock.mockResolvedValue(PREVIEW);
    render(<QuarterlyCycleWidget tenantId="t1" planId="p1" consumedByDimension={{ content_pieces: 27 }} />);
    await waitFor(() => screen.getByTestId('quarterly-cycle-bar-content_pieces'));
    const bar = screen.getByTestId('quarterly-cycle-bar-content_pieces');
    expect(bar.className).toContain('ironwake');
  });

  it('progressbar has correct aria attributes', async () => {
    apiGetMock.mockResolvedValue(PREVIEW);
    render(<QuarterlyCycleWidget tenantId="t1" planId="p1" consumedByDimension={{ content_pieces: 12 }} />);
    await waitFor(() => screen.getByTestId('quarterly-cycle-bar-content_pieces'));
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('12');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('30');
  });
});
