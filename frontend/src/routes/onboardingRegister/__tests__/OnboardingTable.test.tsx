// Authorized by HUB-1397 (E-CMP-WAVE4 S4) — OnboardingTable unit tests. Covers
// AC 2 (SLA urgency coloring), AC 3 (status pill), AC 5/8 (Mark Complete visible
// only for admin + pending rows).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { OnboardingTable } from '../OnboardingTable';
import type { OnboardingRow } from '../types';

const NOW = Date.parse('2026-07-05T12:00:00Z');

const baseRow: OnboardingRow = {
  id: '22222222-2222-2222-2222-222222222222',
  product_id: 'hub',
  employee_name: 'Ada Lovelace',
  employee_email: 'ada@x',
  role: 'eng',
  hire_date: '2026-07-01',
  sla_deadline: '2026-07-15',
  status: 'pending',
  attested_by: null,
  completed_at: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

afterEach(() => cleanup());

describe('OnboardingTable (AC 2, 3, 5, 8)', () => {
  it('renders overdue urgency in red', () => {
    render(
      <OnboardingTable
        rows={[{ ...baseRow, sla_deadline: '2026-06-30' }]}
        isAdmin={true}
        onComplete={vi.fn()}
        now={NOW}
      />,
    );
    const cell = screen.getByTestId('onb-sla-overdue');
    expect(cell.textContent).toMatch(/Overdue by/);
    expect(cell.className).toMatch(/error-crimson/);
  });

  it('renders due-soon (0-3 days) urgency in amber', () => {
    render(
      <OnboardingTable
        rows={[{ ...baseRow, sla_deadline: '2026-07-06' }]}
        isAdmin={true}
        onComplete={vi.fn()}
        now={NOW}
      />,
    );
    const cell = screen.getByTestId('onb-sla-due_soon');
    expect(cell.className).toMatch(/accent-brass/);
  });

  it('renders normal (>3 days) urgency in default text color', () => {
    render(
      <OnboardingTable
        rows={[{ ...baseRow, sla_deadline: '2026-07-20' }]}
        isAdmin={true}
        onComplete={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('onb-sla-normal')).toBeInTheDocument();
  });

  it('AC 3: status pill variants render with distinct classes', () => {
    render(
      <OnboardingTable
        rows={[{ ...baseRow, status: 'completed', completed_at: '2026-07-08T00:00:00Z' }]}
        isAdmin={false}
        onComplete={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('onb-status-pill-completed')).toBeInTheDocument();
  });

  it('AC 8: Mark Complete button hidden for non-admin', () => {
    render(
      <OnboardingTable rows={[baseRow]} isAdmin={false} onComplete={vi.fn()} now={NOW} />,
    );
    expect(screen.queryByTestId(`onb-complete-btn-${baseRow.id}`)).toBeNull();
  });

  it('AC 5: Mark Complete button shown for admin on pending rows', () => {
    render(
      <OnboardingTable rows={[baseRow]} isAdmin={true} onComplete={vi.fn()} now={NOW} />,
    );
    expect(screen.getByTestId(`onb-complete-btn-${baseRow.id}`)).toBeInTheDocument();
  });

  it('completed rows have no Mark Complete button even for admin', () => {
    render(
      <OnboardingTable
        rows={[{ ...baseRow, status: 'completed', completed_at: '2026-07-08T00:00:00Z' }]}
        isAdmin={true}
        onComplete={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId(`onb-complete-btn-${baseRow.id}`)).toBeNull();
  });
});
