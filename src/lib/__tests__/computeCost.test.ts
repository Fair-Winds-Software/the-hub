// Authorized by HUB-609 — unit tests: computeCost for all model types and tiered graduation
import { describe, it, expect } from 'vitest';
import { computeCost } from '../computeCost.js';
import type { PricingModelRow } from '../../services/pricingModelService.js';

function makeModel(overrides: Partial<PricingModelRow>): PricingModelRow {
  return {
    model_id: 'model-1',
    product_id: 'product-1',
    model_type: 'flat_rate',
    currency: 'USD',
    config: {},
    active: true,
    activated_at: '2026-01-01T00:00:00.000Z',
    deprecated_at: null,
    created_by: 'op-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    tiers: [],
    ...overrides,
  };
}

// ── unitCount = 0 ─────────────────────────────────────────────────────────────

describe('computeCost() — unitCount = 0', () => {
  it('returns 0 for any model type when unitCount is 0', () => {
    const model = makeModel({ model_type: 'flat_rate', config: { price_cents: 999 } });
    expect(computeCost(model, 0)).toBe(0);
  });
});

// ── flat_rate ─────────────────────────────────────────────────────────────────

describe('computeCost() — flat_rate', () => {
  it('returns price_cents from config regardless of unitCount', () => {
    const model = makeModel({ model_type: 'flat_rate', config: { price_cents: 2999 } });
    expect(computeCost(model, 1)).toBe(2999);
    expect(computeCost(model, 100)).toBe(2999);
  });

  it('returns 0 when price_cents is missing', () => {
    const model = makeModel({ model_type: 'flat_rate', config: {} });
    expect(computeCost(model, 1)).toBe(0);
  });
});

// ── usage_based ───────────────────────────────────────────────────────────────

describe('computeCost() — usage_based', () => {
  it('returns unit_price_cents * unitCount', () => {
    const model = makeModel({ model_type: 'usage_based', config: { unit_price_cents: 10 } });
    expect(computeCost(model, 50)).toBe(500);
  });

  it('returns 0 when unit_price_cents is 0', () => {
    const model = makeModel({ model_type: 'usage_based', config: { unit_price_cents: 0 } });
    expect(computeCost(model, 100)).toBe(0);
  });

  it('returns 0 when unit_price_cents is missing', () => {
    const model = makeModel({ model_type: 'usage_based', config: {} });
    expect(computeCost(model, 10)).toBe(0);
  });
});

// ── per_seat ──────────────────────────────────────────────────────────────────

describe('computeCost() — per_seat', () => {
  it('returns seat_price_cents * unitCount', () => {
    const model = makeModel({ model_type: 'per_seat', config: { seat_price_cents: 500 } });
    expect(computeCost(model, 5)).toBe(2500);
  });

  it('returns 0 when seat_price_cents is missing', () => {
    const model = makeModel({ model_type: 'per_seat', config: {} });
    expect(computeCost(model, 3)).toBe(0);
  });
});

// ── tiered ────────────────────────────────────────────────────────────────────

describe('computeCost() — tiered', () => {
  it('returns 0 when no tiers are defined', () => {
    const model = makeModel({ model_type: 'tiered', tiers: [] });
    expect(computeCost(model, 10)).toBe(0);
  });

  it('handles single unlimited tier', () => {
    const model = makeModel({
      model_type: 'tiered',
      tiers: [
        { tier_id: 't1', model_id: 'model-1', tier_order: 0, up_to_units: null, unit_price_cents: 50, flat_fee_cents: 0 },
      ],
    });
    expect(computeCost(model, 200)).toBe(10000);
  });

  it('graduates across two tiers', () => {
    const model = makeModel({
      model_type: 'tiered',
      tiers: [
        { tier_id: 't1', model_id: 'model-1', tier_order: 0, up_to_units: 100, unit_price_cents: 100, flat_fee_cents: 0 },
        { tier_id: 't2', model_id: 'model-1', tier_order: 1, up_to_units: null, unit_price_cents: 50, flat_fee_cents: 0 },
      ],
    });
    // 100 * 100 + 50 * 50 = 10000 + 2500 = 12500
    expect(computeCost(model, 150)).toBe(12500);
  });

  it('stays within first tier when units fit', () => {
    const model = makeModel({
      model_type: 'tiered',
      tiers: [
        { tier_id: 't1', model_id: 'model-1', tier_order: 0, up_to_units: 100, unit_price_cents: 100, flat_fee_cents: 0 },
        { tier_id: 't2', model_id: 'model-1', tier_order: 1, up_to_units: null, unit_price_cents: 50, flat_fee_cents: 0 },
      ],
    });
    expect(computeCost(model, 80)).toBe(8000);
  });

  it('applies flat_fee_cents per tier entered', () => {
    const model = makeModel({
      model_type: 'tiered',
      tiers: [
        { tier_id: 't1', model_id: 'model-1', tier_order: 0, up_to_units: 100, unit_price_cents: 0, flat_fee_cents: 1000 },
        { tier_id: 't2', model_id: 'model-1', tier_order: 1, up_to_units: null, unit_price_cents: 10, flat_fee_cents: 500 },
      ],
    });
    // tier 0: 100 units * 0 + 1000 = 1000; tier 1: 50 units * 10 + 500 = 1000; total = 2000
    expect(computeCost(model, 150)).toBe(2000);
  });

  it('does NOT apply flat_fee_cents for a tier with zero units entering it', () => {
    const model = makeModel({
      model_type: 'tiered',
      tiers: [
        { tier_id: 't1', model_id: 'model-1', tier_order: 0, up_to_units: 200, unit_price_cents: 10, flat_fee_cents: 0 },
        { tier_id: 't2', model_id: 'model-1', tier_order: 1, up_to_units: null, unit_price_cents: 5, flat_fee_cents: 9999 },
      ],
    });
    // Only 100 units — stays in tier 0; tier 1 never entered, flat fee NOT charged
    expect(computeCost(model, 100)).toBe(1000);
  });

  it('handles out-of-order tiers by sorting tier_order', () => {
    const model = makeModel({
      model_type: 'tiered',
      tiers: [
        { tier_id: 't2', model_id: 'model-1', tier_order: 1, up_to_units: null, unit_price_cents: 50, flat_fee_cents: 0 },
        { tier_id: 't1', model_id: 'model-1', tier_order: 0, up_to_units: 100, unit_price_cents: 100, flat_fee_cents: 0 },
      ],
    });
    expect(computeCost(model, 150)).toBe(12500);
  });

  it('graduates across three tiers', () => {
    const model = makeModel({
      model_type: 'tiered',
      tiers: [
        { tier_id: 't1', model_id: 'model-1', tier_order: 0, up_to_units: 100, unit_price_cents: 100, flat_fee_cents: 0 },
        { tier_id: 't2', model_id: 'model-1', tier_order: 1, up_to_units: 400, unit_price_cents: 75, flat_fee_cents: 0 },
        { tier_id: 't3', model_id: 'model-1', tier_order: 2, up_to_units: null, unit_price_cents: 50, flat_fee_cents: 0 },
      ],
    });
    // 100 * 100 + 400 * 75 + 500 * 50 = 10000 + 30000 + 25000 = 65000
    expect(computeCost(model, 1000)).toBe(65000);
  });
});

// ── unknown model type ────────────────────────────────────────────────────────

describe('computeCost() — unknown model type', () => {
  it('returns 0 for an unrecognised model type', () => {
    const model = makeModel({ model_type: 'unknown_type' as never, config: { price_cents: 999 } });
    expect(computeCost(model, 10)).toBe(0);
  });
});
