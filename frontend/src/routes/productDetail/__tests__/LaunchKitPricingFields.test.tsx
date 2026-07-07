// Authorized by HUB-1722 + HUB-1724 (E-V2-PP-1 S9/S11, HUB-1713, HUB-1701) —
// Component tests for VolumeLadderEditor + QuantityMeteredFields + their pure
// validation functions. The state ownership sits in EditPlanModal (PlansManager);
// these tests exercise the components directly with controlled props.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  VolumeLadderEditor,
  QuantityMeteredFields,
  validateLadder,
  validateQuantityMetered,
} from '../LaunchKitPricingFields';
import type { VolumeLadderTier } from '../PlansManager';

afterEach(() => cleanup());

// ── HUB-1722 (S9) VolumeLadderEditor ───────────────────────────────────────
describe('HUB-1722 (S9): VolumeLadderEditor', () => {
  it('renders the empty state with an add-first CTA (AC 5)', () => {
    const onChange = vi.fn();
    render(<VolumeLadderEditor readOnly={false} ladder={[]} onChange={onChange} />);
    expect(screen.getByText(/flat pricing/i)).toBeInTheDocument();
    expect(screen.getByTestId('volume-ladder-add-first')).toBeInTheDocument();
  });

  it('adds a first tier when the CTA is clicked', () => {
    const onChange = vi.fn();
    render(<VolumeLadderEditor readOnly={false} ladder={[]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('volume-ladder-add-first'));
    expect(onChange).toHaveBeenCalledWith([
      { min_quantity: 1, max_quantity: 1, unit_amount_cents: 0, sort_order: 0 },
    ]);
  });

  it('renders each tier row + supports remove (AC 7)', () => {
    const ladder: VolumeLadderTier[] = [
      { min_quantity: 1, max_quantity: 1, unit_amount_cents: 0, sort_order: 0 },
      { min_quantity: 2, max_quantity: null, unit_amount_cents: 50000, sort_order: 1 },
    ];
    const onChange = vi.fn();
    render(<VolumeLadderEditor readOnly={false} ladder={ladder} onChange={onChange} />);
    expect(screen.getByTestId('volume-ladder-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('volume-ladder-row-1-remove'));
    expect(onChange).toHaveBeenCalledWith([ladder[0]]);
  });

  it('hides remove + add buttons when readOnly=true (AC 6)', () => {
    const ladder: VolumeLadderTier[] = [
      { min_quantity: 1, max_quantity: null, unit_amount_cents: 100, sort_order: 0 },
    ];
    render(<VolumeLadderEditor readOnly={true} ladder={ladder} onChange={vi.fn()} />);
    expect(screen.queryByTestId('volume-ladder-row-0-remove')).toBeNull();
    expect(screen.queryByTestId('volume-ladder-add')).toBeNull();
  });

  it('shows an overlap error for two tiers with intersecting ranges (AC 3)', () => {
    const ladder: VolumeLadderTier[] = [
      { min_quantity: 1, max_quantity: 5, unit_amount_cents: 10000, sort_order: 0 },
      { min_quantity: 3, max_quantity: null, unit_amount_cents: 5000, sort_order: 1 },
    ];
    render(<VolumeLadderEditor readOnly={false} ladder={ladder} onChange={vi.fn()} />);
    expect(screen.getByTestId('volume-ladder-row-0-error')).toHaveTextContent(/overlap/i);
    expect(screen.getByTestId('volume-ladder-row-1-error')).toHaveTextContent(/overlap/i);
  });

  it('shows an error for min_quantity < 1', () => {
    const ladder: VolumeLadderTier[] = [
      { min_quantity: 0, max_quantity: 1, unit_amount_cents: 0, sort_order: 0 },
    ];
    render(<VolumeLadderEditor readOnly={false} ladder={ladder} onChange={vi.fn()} />);
    expect(screen.getByTestId('volume-ladder-row-0-error')).toHaveTextContent(/≥ 1/);
  });

  it('shows an error for max_quantity < min_quantity', () => {
    const ladder: VolumeLadderTier[] = [
      { min_quantity: 5, max_quantity: 3, unit_amount_cents: 0, sort_order: 0 },
    ];
    render(<VolumeLadderEditor readOnly={false} ladder={ladder} onChange={vi.fn()} />);
    expect(screen.getByTestId('volume-ladder-row-0-error')).toHaveTextContent(/max quantity/i);
  });
});

// ── validateLadder pure function ───────────────────────────────────────────
describe('validateLadder', () => {
  it('returns no errors for a well-formed ladder', () => {
    const ladder: VolumeLadderTier[] = [
      { min_quantity: 1, max_quantity: 1, unit_amount_cents: 0, sort_order: 0 },
      { min_quantity: 2, max_quantity: 2, unit_amount_cents: 50000, sort_order: 1 },
      { min_quantity: 3, max_quantity: null, unit_amount_cents: 30000, sort_order: 2 },
    ];
    expect(validateLadder(ladder)).toEqual([null, null, null]);
  });

  it('detects overlap between an open-ended tier and a subsequent bounded tier', () => {
    const ladder: VolumeLadderTier[] = [
      { min_quantity: 1, max_quantity: null, unit_amount_cents: 100, sort_order: 0 },
      { min_quantity: 2, max_quantity: 3, unit_amount_cents: 200, sort_order: 1 },
    ];
    const errors = validateLadder(ladder);
    expect(errors[0]).toMatch(/overlap/i);
    expect(errors[1]).toMatch(/overlap/i);
  });
});

// ── HUB-1724 (S11) QuantityMeteredFields ───────────────────────────────────
describe('HUB-1724 (S11): QuantityMeteredFields', () => {
  it('hides first_n_free when dimension is null (AC 2)', () => {
    render(
      <QuantityMeteredFields
        readOnly={false}
        dimension={null}
        firstNFree={0}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('quantity-first-n-free')).toBeNull();
  });

  it('shows first_n_free when a dimension is selected (AC 1)', () => {
    render(
      <QuantityMeteredFields
        readOnly={false}
        dimension="environment"
        firstNFree={1}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('quantity-first-n-free')).toHaveValue(1);
  });

  it('clears first_n_free when the dimension is cleared (AC 2)', () => {
    const onChange = vi.fn();
    render(
      <QuantityMeteredFields
        readOnly={false}
        dimension="environment"
        firstNFree={3}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('quantity-metered-dimension'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ dimension: null, firstNFree: 0 });
  });

  it('surfaces cross-field error when first_n_free>0 without dimension (AC 4)', () => {
    // The parent shouldn't normally allow this combo, but if it does the component surfaces it.
    render(
      <QuantityMeteredFields
        readOnly={false}
        dimension={null}
        firstNFree={3}
        onChange={vi.fn()}
      />,
    );
    // But since dimension=null, first_n_free field isn't rendered. Verify via the validation
    // helper on this exact state instead.
    expect(validateQuantityMetered(null, 3)).toMatch(/selecting a metered dimension/i);
  });

  it('validation rejects negative first_n_free', () => {
    expect(validateQuantityMetered('environment', -1)).toMatch(/negative/);
  });

  it('validation passes when both fields are consistent', () => {
    expect(validateQuantityMetered('environment', 1)).toBeNull();
    expect(validateQuantityMetered(null, 0)).toBeNull();
  });

  it('disables the select when readOnly=true (AC 6)', () => {
    render(
      <QuantityMeteredFields
        readOnly={true}
        dimension="environment"
        firstNFree={1}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('quantity-metered-dimension')).toBeDisabled();
  });
});
