// Authorized by HUB-567 — unit tests: validatePricingModelConfig
import { describe, it, expect } from 'vitest';
import { validatePricingModelConfig } from '../pricingModelValidation.js';
import type { TierInput } from '../pricingModelValidation.js';

// ── invalid model_type ────────────────────────────────────────────────────────

describe('validatePricingModelConfig() — invalid model_type', () => {
  it('throws 400 for unknown model_type', () => {
    expect(() => validatePricingModelConfig('unknown', {})).toThrow();
  });

  it('throws AppError with statusCode 400 for unknown model_type', () => {
    try {
      validatePricingModelConfig('subscription', {});
    } catch (err: unknown) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
    }
  });
});

// ── flat_rate ─────────────────────────────────────────────────────────────────

describe('validatePricingModelConfig() — flat_rate', () => {
  it('passes for valid flat_rate config', () => {
    expect(() => validatePricingModelConfig('flat_rate', { price_cents: 999 })).not.toThrow();
  });

  it('throws 400 when price_cents is missing', () => {
    expect(() => validatePricingModelConfig('flat_rate', {})).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when price_cents is not an integer', () => {
    expect(() => validatePricingModelConfig('flat_rate', { price_cents: 9.99 })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when price_cents is zero', () => {
    expect(() => validatePricingModelConfig('flat_rate', { price_cents: 0 })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when price_cents is negative', () => {
    expect(() => validatePricingModelConfig('flat_rate', { price_cents: -1 })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when tiers are provided for flat_rate', () => {
    const tiers: TierInput[] = [{ tier_order: 0, up_to_units: null, unit_price_cents: 100, flat_fee_cents: 0 }];
    expect(() => validatePricingModelConfig('flat_rate', { price_cents: 999 }, tiers)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('passes when empty tiers array is provided for flat_rate', () => {
    expect(() => validatePricingModelConfig('flat_rate', { price_cents: 100 }, [])).not.toThrow();
  });
});

// ── tiered ────────────────────────────────────────────────────────────────────

describe('validatePricingModelConfig() — tiered', () => {
  const validTiers: TierInput[] = [
    { tier_order: 0, up_to_units: 100, unit_price_cents: 50, flat_fee_cents: 0 },
    { tier_order: 1, up_to_units: null, unit_price_cents: 30, flat_fee_cents: 0 },
  ];

  it('passes for valid tiered config with tiers', () => {
    expect(() => validatePricingModelConfig('tiered', {}, validTiers)).not.toThrow();
  });

  it('throws 400 when no tiers provided', () => {
    expect(() => validatePricingModelConfig('tiered', {})).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when empty tiers array provided', () => {
    expect(() => validatePricingModelConfig('tiered', {}, [])).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when final tier has non-null up_to_units', () => {
    const tiers: TierInput[] = [
      { tier_order: 0, up_to_units: 100, unit_price_cents: 50, flat_fee_cents: 0 },
      { tier_order: 1, up_to_units: 500, unit_price_cents: 30, flat_fee_cents: 0 },
    ];
    expect(() => validatePricingModelConfig('tiered', {}, tiers)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when non-final tier has null up_to_units', () => {
    const tiers: TierInput[] = [
      { tier_order: 0, up_to_units: null, unit_price_cents: 50, flat_fee_cents: 0 },
      { tier_order: 1, up_to_units: null, unit_price_cents: 30, flat_fee_cents: 0 },
    ];
    expect(() => validatePricingModelConfig('tiered', {}, tiers)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when unit_price_cents is negative', () => {
    const tiers: TierInput[] = [
      { tier_order: 0, up_to_units: null, unit_price_cents: -1, flat_fee_cents: 0 },
    ];
    expect(() => validatePricingModelConfig('tiered', {}, tiers)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when flat_fee_cents is negative', () => {
    const tiers: TierInput[] = [
      { tier_order: 0, up_to_units: null, unit_price_cents: 0, flat_fee_cents: -5 },
    ];
    expect(() => validatePricingModelConfig('tiered', {}, tiers)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when tier_order values are duplicated', () => {
    const tiers: TierInput[] = [
      { tier_order: 0, up_to_units: 100, unit_price_cents: 50, flat_fee_cents: 0 },
      { tier_order: 0, up_to_units: null, unit_price_cents: 30, flat_fee_cents: 0 },
    ];
    expect(() => validatePricingModelConfig('tiered', {}, tiers)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('passes with zero unit_price_cents (free tier)', () => {
    const tiers: TierInput[] = [
      { tier_order: 0, up_to_units: null, unit_price_cents: 0, flat_fee_cents: 0 },
    ];
    expect(() => validatePricingModelConfig('tiered', {}, tiers)).not.toThrow();
  });
});

// ── usage_based ───────────────────────────────────────────────────────────────

describe('validatePricingModelConfig() — usage_based', () => {
  it('passes for valid usage_based config', () => {
    expect(() => validatePricingModelConfig('usage_based', { unit_price_cents: 5 })).not.toThrow();
  });

  it('passes when unit_price_cents is zero (free usage)', () => {
    expect(() => validatePricingModelConfig('usage_based', { unit_price_cents: 0 })).not.toThrow();
  });

  it('throws 400 when unit_price_cents is missing', () => {
    expect(() => validatePricingModelConfig('usage_based', {})).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when unit_price_cents is negative', () => {
    expect(() => validatePricingModelConfig('usage_based', { unit_price_cents: -1 })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when tiers are provided for usage_based', () => {
    const tiers: TierInput[] = [{ tier_order: 0, up_to_units: null, unit_price_cents: 5, flat_fee_cents: 0 }];
    expect(() =>
      validatePricingModelConfig('usage_based', { unit_price_cents: 5 }, tiers),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

// ── per_seat ──────────────────────────────────────────────────────────────────

describe('validatePricingModelConfig() — per_seat', () => {
  it('passes for valid per_seat config', () => {
    expect(() =>
      validatePricingModelConfig('per_seat', { seat_price_cents: 1000 }),
    ).not.toThrow();
  });

  it('throws 400 when seat_price_cents is missing', () => {
    expect(() => validatePricingModelConfig('per_seat', {})).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when seat_price_cents is zero', () => {
    expect(() => validatePricingModelConfig('per_seat', { seat_price_cents: 0 })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when seat_price_cents is negative', () => {
    expect(() => validatePricingModelConfig('per_seat', { seat_price_cents: -100 })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('throws 400 when tiers are provided for per_seat', () => {
    const tiers: TierInput[] = [{ tier_order: 0, up_to_units: null, unit_price_cents: 0, flat_fee_cents: 0 }];
    expect(() =>
      validatePricingModelConfig('per_seat', { seat_price_cents: 1000 }, tiers),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
