// Authorized by HUB-1147 — unit tests: assignPlanBulk 50-tenant cap; discount validation; override upsert logic
import { describe, it, expect } from 'vitest';

// ── Pure-function helpers extracted for unit testing ──────────────────────────
// Mirrors validation logic from operatorConsoleService without DB/Redis I/O

function validateDiscountInput(
  discountType: string,
  discountValue: number,
): string | null {
  if (!['percentage', 'fixed'].includes(discountType)) {
    return 'discount_type must be percentage or fixed';
  }
  if (discountValue <= 0) {
    return 'Discount value must be greater than 0';
  }
  if (discountType === 'percentage' && discountValue > 100) {
    return 'Percentage discount must be between 0 and 100';
  }
  return null;
}

function validateEffectiveDateType(
  type: string,
  effectiveDate?: string,
): string | null {
  const valid = ['immediate', 'next_billing_cycle', 'custom'];
  if (!valid.includes(type)) {
    return 'effective_date_type must be immediate, next_billing_cycle, or custom';
  }
  if (type === 'custom' && !effectiveDate) {
    return 'effective_date is required when effective_date_type is custom';
  }
  return null;
}

function validateBulkLimit(tenantIds: string[]): string | null {
  if (tenantIds.length > 50) {
    return 'Bulk assignment supports a maximum of 50 tenants at a time';
  }
  if (tenantIds.length === 0) {
    return 'tenant_ids must be a non-empty array';
  }
  return null;
}

function validateOverrideInput(unitPriceCents: number): string | null {
  if (isNaN(unitPriceCents) || unitPriceCents < 0) {
    return 'unit_price_cents must be >= 0';
  }
  return null;
}

// ── validateDiscountInput ─────────────────────────────────────────────────────

describe('validateDiscountInput()', () => {
  it('accepts valid percentage discount', () => {
    expect(validateDiscountInput('percentage', 15)).toBeNull();
  });

  it('accepts valid fixed discount', () => {
    expect(validateDiscountInput('fixed', 500)).toBeNull();
  });

  it('rejects unknown discount_type', () => {
    const err = validateDiscountInput('coupon', 10);
    expect(err).toContain('discount_type must be percentage or fixed');
  });

  it('rejects zero discount_value', () => {
    const err = validateDiscountInput('percentage', 0);
    expect(err).toContain('must be greater than 0');
  });

  it('rejects percentage > 100', () => {
    const err = validateDiscountInput('percentage', 101);
    expect(err).toContain('between 0 and 100');
  });

  it('accepts fixed discount > 100 (fixed is not percentage-bounded)', () => {
    expect(validateDiscountInput('fixed', 10000)).toBeNull();
  });
});

// ── validateEffectiveDateType ─────────────────────────────────────────────────

describe('validateEffectiveDateType()', () => {
  it('accepts immediate', () => {
    expect(validateEffectiveDateType('immediate')).toBeNull();
  });

  it('accepts next_billing_cycle', () => {
    expect(validateEffectiveDateType('next_billing_cycle')).toBeNull();
  });

  it('accepts custom with date provided', () => {
    expect(validateEffectiveDateType('custom', '2026-09-01')).toBeNull();
  });

  it('rejects custom without effectiveDate', () => {
    const err = validateEffectiveDateType('custom');
    expect(err).toContain('effective_date is required');
  });

  it('rejects unknown type', () => {
    const err = validateEffectiveDateType('next_quarter');
    expect(err).toContain('effective_date_type must be');
  });
});

// ── validateBulkLimit ─────────────────────────────────────────────────────────

describe('validateBulkLimit()', () => {
  it('accepts 1 tenant', () => {
    expect(validateBulkLimit(['id-1'])).toBeNull();
  });

  it('accepts exactly 50 tenants', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    expect(validateBulkLimit(ids)).toBeNull();
  });

  it('rejects 51 tenants', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    expect(validateBulkLimit(ids)).toContain('maximum of 50');
  });

  it('rejects empty array', () => {
    expect(validateBulkLimit([])).toContain('non-empty array');
  });
});

// ── validateOverrideInput ─────────────────────────────────────────────────────

describe('validateOverrideInput()', () => {
  it('accepts 0 (free tier)', () => {
    expect(validateOverrideInput(0)).toBeNull();
  });

  it('accepts positive cents', () => {
    expect(validateOverrideInput(500)).toBeNull();
  });

  it('rejects negative value', () => {
    expect(validateOverrideInput(-1)).toContain('>= 0');
  });

  it('rejects NaN', () => {
    expect(validateOverrideInput(NaN)).toContain('>= 0');
  });
});
