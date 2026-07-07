// Authorized by HUB-1746 + HUB-1747 (E-V2-PP-3 S6/S7, HUB-1727, HUB-1701) —
// Component tests for OverageMatrix + OveragePreview + validateDimensions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  OverageMatrix,
  OveragePreview,
  validateDimensions,
  type Dimension,
  type TierWithOverage,
} from '../OverageMatrix';

const apiPostMock = vi.fn();
vi.mock('../../../lib/api', () => ({
  apiClient: { post: (...args: unknown[]) => apiPostMock(...args) },
}));

beforeEach(() => apiPostMock.mockReset());
afterEach(() => cleanup());

// ── HUB-1746 (S6) OverageMatrix + validateDimensions ─────────────────────
describe('HUB-1746 (S6): OverageMatrix', () => {
  const dims: Dimension[] = [
    { dimension_key: 'rules', dimension_label: 'Rules', sort_order: 0 },
    { dimension_key: 'business_users', dimension_label: 'Users', sort_order: 1 },
  ];
  const tiers: TierWithOverage[] = [
    {
      upTo: 1000, unitAmount: 9900,
      overage_rates: [
        { dimension_key: 'rules', included_quantity: 100, rate_per_unit_cents: 10 },
      ],
    },
    {
      upTo: null, unitAmount: 99900,
      overage_rates: [
        { dimension_key: 'rules', included_quantity: 500, rate_per_unit_cents: 5 },
        { dimension_key: 'business_users', included_quantity: 50, rate_per_unit_cents: 100 },
      ],
    },
  ];

  it('renders the matrix table with dim rows × tier columns', () => {
    render(
      <OverageMatrix
        readOnly={false}
        dimensions={dims}
        tiers={tiers}
        onDimensionsChange={vi.fn()}
        onTiersChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('overage-matrix')).toBeInTheDocument();
    expect(screen.getByTestId('overage-matrix-table')).toBeInTheDocument();
    expect(screen.getByTestId('matrix-row-rules')).toBeInTheDocument();
    expect(screen.getByTestId('matrix-row-business_users')).toBeInTheDocument();
    // Cell values.
    expect(screen.getByTestId('matrix-included-rules-0')).toHaveValue(100);
    expect(screen.getByTestId('matrix-rate-rules-0')).toHaveValue(10);
    // Cell that isn't populated returns 0 default.
    expect(screen.getByTestId('matrix-included-business_users-0')).toHaveValue(0);
  });

  it('adds a dimension via Add button (AC 2)', () => {
    const onDimensionsChange = vi.fn();
    render(
      <OverageMatrix
        readOnly={false}
        dimensions={[]}
        tiers={tiers}
        onDimensionsChange={onDimensionsChange}
        onTiersChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('dimension-add'));
    expect(onDimensionsChange).toHaveBeenCalledWith([
      { dimension_key: 'dim_1', dimension_label: 'dim_1', sort_order: 0 },
    ]);
  });

  it('removes a dimension and also strips it from all tiers (S6 cascade)', () => {
    const onDimensionsChange = vi.fn();
    const onTiersChange = vi.fn();
    render(
      <OverageMatrix
        readOnly={false}
        dimensions={dims}
        tiers={tiers}
        onDimensionsChange={onDimensionsChange}
        onTiersChange={onTiersChange}
      />,
    );
    fireEvent.click(screen.getByTestId('dimension-remove-0')); // remove 'rules'
    expect(onDimensionsChange).toHaveBeenCalledWith([dims[1]]);
    // All tiers must have overage_rates without 'rules'.
    expect(onTiersChange).toHaveBeenCalledWith(
      tiers.map((t) => ({
        ...t,
        overage_rates: t.overage_rates?.filter((r) => r.dimension_key !== 'rules'),
      })),
    );
  });

  it('updateCell writes an overage_rate for a previously unset (dim, tier)', () => {
    const onTiersChange = vi.fn();
    render(
      <OverageMatrix
        readOnly={false}
        dimensions={dims}
        tiers={tiers}
        onDimensionsChange={vi.fn()}
        onTiersChange={onTiersChange}
      />,
    );
    // business_users at tier 0 has no overage_rate initially. Set rate to 250.
    fireEvent.change(screen.getByTestId('matrix-rate-business_users-0'), { target: { value: '250' } });
    const nextTiers = onTiersChange.mock.calls[0]![0] as TierWithOverage[];
    const t0Rate = nextTiers[0]!.overage_rates!.find((r) => r.dimension_key === 'business_users');
    expect(t0Rate).toEqual({ dimension_key: 'business_users', included_quantity: 0, rate_per_unit_cents: 250 });
  });

  it('hides add/remove buttons when readOnly=true', () => {
    render(
      <OverageMatrix
        readOnly={true}
        dimensions={dims}
        tiers={tiers}
        onDimensionsChange={vi.fn()}
        onTiersChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('dimension-add')).toBeNull();
    expect(screen.queryByTestId('dimension-remove-0')).toBeNull();
  });
});

describe('validateDimensions', () => {
  it('accepts snake_case keys', () => {
    expect(validateDimensions([{ dimension_key: 'rules', dimension_label: 'Rules', sort_order: 0 }])).toEqual([null]);
  });
  it('rejects CamelCase keys', () => {
    const errors = validateDimensions([{ dimension_key: 'BadKey', dimension_label: 'X', sort_order: 0 }]);
    expect(errors[0]).toMatch(/snake_case/i);
  });
  it('rejects duplicate keys', () => {
    const errors = validateDimensions([
      { dimension_key: 'rules', dimension_label: 'A', sort_order: 0 },
      { dimension_key: 'rules', dimension_label: 'B', sort_order: 1 },
    ]);
    expect(errors[1]).toMatch(/duplicate/i);
  });
  it('rejects empty label', () => {
    const errors = validateDimensions([{ dimension_key: 'rules', dimension_label: '', sort_order: 0 }]);
    expect(errors[0]).toMatch(/label/i);
  });
});

// ── HUB-1747 (S7) OveragePreview ────────────────────────────────────────
describe('HUB-1747 (S7): OveragePreview', () => {
  const PLAN_ID = 'plan-1';

  it('starts in idle state — runs simulate on button click', async () => {
    apiPostMock.mockResolvedValueOnce({
      tenants_over: 2,
      total_overage_cents: 25000,
      biggest_impact: { tenant_id: 't1', tenant_name: 'Acme Corp', total_overage_cents: 15000 },
      per_tenant: [
        { tenant_id: 't1', tenant_name: 'Acme Corp', total_overage_cents: 15000 },
        { tenant_id: 't2', tenant_name: 'Beta LLC', total_overage_cents: 10000 },
      ],
    });
    render(<OveragePreview planId={PLAN_ID} />);
    fireEvent.click(screen.getByTestId('overage-preview-run'));
    await waitFor(() => expect(screen.getByTestId('overage-preview-summary')).toBeInTheDocument());
    // Summary shows "2 tenant(s)" and formatted total.
    expect(screen.getByTestId('overage-preview-summary').textContent).toContain('2');
    expect(screen.getByTestId('overage-preview-summary').textContent).toContain('$250.00');
    expect(screen.getByTestId('overage-preview-summary').textContent).toContain('Acme Corp');
  });

  it('per-tenant breakdown toggle shows/hides list', async () => {
    apiPostMock.mockResolvedValueOnce({
      tenants_over: 1,
      total_overage_cents: 500,
      biggest_impact: { tenant_id: 't1', tenant_name: 'Only', total_overage_cents: 500 },
      per_tenant: [{ tenant_id: 't1', tenant_name: 'Only', total_overage_cents: 500 }],
    });
    render(<OveragePreview planId={PLAN_ID} />);
    fireEvent.click(screen.getByTestId('overage-preview-run'));
    await waitFor(() => screen.getByTestId('overage-preview-toggle'));
    // Not expanded by default.
    expect(screen.queryByTestId('overage-preview-list')).toBeNull();
    fireEvent.click(screen.getByTestId('overage-preview-toggle'));
    expect(screen.getByTestId('overage-preview-list')).toBeInTheDocument();
    expect(screen.getByTestId('overage-preview-list').textContent).toContain('Only');
  });

  it('shows error when simulate fails', async () => {
    apiPostMock.mockRejectedValueOnce(new Error('boom'));
    render(<OveragePreview planId={PLAN_ID} />);
    fireEvent.click(screen.getByTestId('overage-preview-run'));
    await waitFor(() => expect(screen.getByTestId('overage-preview-error')).toBeInTheDocument());
    expect(screen.getByTestId('overage-preview-error').textContent).toContain('boom');
  });
});
