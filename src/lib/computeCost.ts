// Authorized by HUB-609 — computeCost; pure function; graduated tiered billing + flat_rate/usage_based/per_seat

import type { PricingModelRow, TierRow } from '../services/pricingModelService.js';

export function computeCost(model: PricingModelRow, unitCount: number): number {
  if (unitCount === 0) return 0;

  switch (model.model_type) {
    case 'flat_rate': {
      const price = model.config['price_cents'];
      return typeof price === 'number' ? price : 0;
    }

    case 'usage_based': {
      const unitPrice = model.config['unit_price_cents'];
      return typeof unitPrice === 'number' ? unitPrice * unitCount : 0;
    }

    case 'per_seat': {
      const seatPrice = model.config['seat_price_cents'];
      return typeof seatPrice === 'number' ? seatPrice * unitCount : 0;
    }

    case 'tiered': {
      return computeTieredCost(model.tiers ?? [], unitCount);
    }

    default:
      return 0;
  }
}

function computeTieredCost(tiers: TierRow[], unitCount: number): number {
  if (tiers.length === 0) return 0;

  const sorted = [...tiers].sort((a, b) => a.tier_order - b.tier_order);
  let remaining = unitCount;
  let total = 0;

  for (const tier of sorted) {
    if (remaining <= 0) break;

    const tierCapacity = tier.up_to_units === null ? remaining : tier.up_to_units;
    const unitsInTier = Math.min(remaining, tierCapacity);

    total += unitsInTier * tier.unit_price_cents;
    if (unitsInTier > 0) {
      total += tier.flat_fee_cents;
    }

    remaining -= unitsInTier;
  }

  return total;
}
