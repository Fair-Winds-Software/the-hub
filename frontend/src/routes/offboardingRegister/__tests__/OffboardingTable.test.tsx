// Authorized by HUB-1398 (E-CMP-WAVE4 S5) — OffboardingTable unit tests. Covers
// AC 2 (revocation deadline urgency), AC 3 (status pill), AC 5 (interactive checklist
// checkboxes fire onChecklistToggle), AC 7 (checkboxes disabled for non-admin +
// disabled after completion).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OffboardingTable } from '../OffboardingTable';
import type { OffboardingRow } from '../types';

const NOW = Date.parse('2026-07-05T12:00:00Z');

const baseRow: OffboardingRow = {
  id: '33333333-3333-3333-3333-333333333333',
  product_id: 'hub',
  employee_name: 'Bob Byrd',
  employee_email: 'bob@x',
  role: 'eng',
  last_day: '2026-07-04',
  revocation_deadline: '2026-07-05T18:00:00Z',
  device_returned: false,
  accounts_disabled: false,
  tokens_revoked: false,
  status: 'pending',
  attested_by: null,
  completed_at: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

afterEach(() => cleanup());

describe('OffboardingTable — deadline urgency (AC 2)', () => {
  it('overdue deadline renders in red', () => {
    render(
      <OffboardingTable
        rows={[{ ...baseRow, revocation_deadline: '2026-07-05T10:00:00Z' }]}
        isAdmin={true}
        onChecklistToggle={vi.fn()}
        now={NOW}
      />,
    );
    const cell = screen.getByTestId('off-urgency-overdue');
    expect(cell.className).toMatch(/error-crimson/);
  });

  it('due_soon (within 2h) renders in amber', () => {
    render(
      <OffboardingTable
        rows={[{ ...baseRow, revocation_deadline: '2026-07-05T13:30:00Z' }]}
        isAdmin={true}
        onChecklistToggle={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('off-urgency-due_soon').className).toMatch(/accent-brass/);
  });

  it('normal (>2h) renders in default color', () => {
    render(
      <OffboardingTable
        rows={[{ ...baseRow, revocation_deadline: '2026-07-06T00:00:00Z' }]}
        isAdmin={true}
        onChecklistToggle={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('off-urgency-normal')).toBeInTheDocument();
  });
});

describe('OffboardingTable — checklist (AC 5, 7)', () => {
  it('AC 5: admin toggle fires onChecklistToggle with the field name + new value', () => {
    const toggle = vi.fn();
    render(
      <OffboardingTable
        rows={[baseRow]}
        isAdmin={true}
        onChecklistToggle={toggle}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByTestId(`off-check-device_returned-${baseRow.id}`));
    expect(toggle).toHaveBeenCalledWith(baseRow, 'device_returned', true);
  });

  it('AC 7: checkboxes are disabled for non-admin', () => {
    render(
      <OffboardingTable
        rows={[baseRow]}
        isAdmin={false}
        onChecklistToggle={vi.fn()}
        now={NOW}
      />,
    );
    const cb = screen.getByTestId(`off-check-device_returned-${baseRow.id}`) as HTMLInputElement;
    expect(cb.disabled).toBe(true);
  });

  it('checkboxes are disabled once record is completed (even for admin)', () => {
    render(
      <OffboardingTable
        rows={[{
          ...baseRow,
          device_returned: true,
          accounts_disabled: true,
          tokens_revoked: true,
          status: 'completed',
          completed_at: '2026-07-05T12:00:00Z',
        }]}
        isAdmin={true}
        onChecklistToggle={vi.fn()}
        now={NOW}
      />,
    );
    const cb = screen.getByTestId(`off-check-device_returned-${baseRow.id}`) as HTMLInputElement;
    expect(cb.disabled).toBe(true);
  });

  it('progress cell renders N/3 based on booleans', () => {
    render(
      <OffboardingTable
        rows={[{ ...baseRow, device_returned: true, accounts_disabled: true, tokens_revoked: false }]}
        isAdmin={false}
        onChecklistToggle={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId(`off-checklist-progress-${baseRow.id}`).textContent).toBe('2/3');
  });
});

describe('OffboardingTable — status pill (AC 3)', () => {
  it('completed status pill renders with success styling', () => {
    render(
      <OffboardingTable
        rows={[{ ...baseRow, status: 'completed', completed_at: '2026-07-05T12:00:00Z' }]}
        isAdmin={false}
        onChecklistToggle={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('off-status-pill-completed')).toBeInTheDocument();
  });
});
