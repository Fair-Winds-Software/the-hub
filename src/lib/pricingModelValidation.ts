// Authorized by HUB-567 — validatePricingModelConfig; pure validation for pricing model structures

import { AppError } from '../errors/AppError.js';

export interface TierInput {
  tier_order: number;
  up_to_units: number | null;
  unit_price_cents: number;
  flat_fee_cents: number;
}

const VALID_MODEL_TYPES = ['flat_rate', 'tiered', 'usage_based', 'per_seat'] as const;
type ModelType = (typeof VALID_MODEL_TYPES)[number];

export function validatePricingModelConfig(
  modelType: string,
  config: Record<string, unknown>,
  tiers?: TierInput[],
): void {
  if (!VALID_MODEL_TYPES.includes(modelType as ModelType)) {
    throw new AppError(400, `model_type must be one of: ${VALID_MODEL_TYPES.join(', ')}`);
  }

  switch (modelType as ModelType) {
    case 'flat_rate':
      validateFlatRate(config, tiers);
      break;
    case 'tiered':
      validateTiered(tiers);
      break;
    case 'usage_based':
      validateUsageBased(config, tiers);
      break;
    case 'per_seat':
      validatePerSeat(config, tiers);
      break;
  }
}

function validateFlatRate(config: Record<string, unknown>, tiers?: TierInput[]): void {
  if (
    typeof config.price_cents !== 'number' ||
    !Number.isInteger(config.price_cents) ||
    config.price_cents <= 0
  ) {
    throw new AppError(400, 'flat_rate model requires config.price_cents to be a positive integer');
  }
  if (tiers && tiers.length > 0) {
    throw new AppError(400, 'flat_rate model does not support tiers');
  }
}

function validateTiered(tiers?: TierInput[]): void {
  if (!tiers || tiers.length === 0) {
    throw new AppError(400, 'tiered model requires at least one tier');
  }

  const orders = tiers.map((t) => t.tier_order);
  if (new Set(orders).size !== orders.length) {
    throw new AppError(400, 'tier_order values must be unique');
  }

  const sorted = [...tiers].sort((a, b) => a.tier_order - b.tier_order);

  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i]!;
    const isLast = i === sorted.length - 1;

    if (!Number.isInteger(tier.unit_price_cents) || tier.unit_price_cents < 0) {
      throw new AppError(
        400,
        `tier at order ${tier.tier_order}: unit_price_cents must be a non-negative integer`,
      );
    }
    if (!Number.isInteger(tier.flat_fee_cents) || tier.flat_fee_cents < 0) {
      throw new AppError(
        400,
        `tier at order ${tier.tier_order}: flat_fee_cents must be a non-negative integer`,
      );
    }
    if (isLast && tier.up_to_units !== null) {
      throw new AppError(400, 'the final tier must have up_to_units = null (unbounded)');
    }
    if (
      !isLast &&
      (tier.up_to_units === null ||
        !Number.isInteger(tier.up_to_units) ||
        tier.up_to_units <= 0)
    ) {
      throw new AppError(
        400,
        `tier at order ${tier.tier_order}: up_to_units must be a positive integer for non-final tiers`,
      );
    }
  }
}

function validateUsageBased(config: Record<string, unknown>, tiers?: TierInput[]): void {
  if (
    typeof config.unit_price_cents !== 'number' ||
    !Number.isInteger(config.unit_price_cents) ||
    config.unit_price_cents < 0
  ) {
    throw new AppError(
      400,
      'usage_based model requires config.unit_price_cents to be a non-negative integer',
    );
  }
  if (tiers && tiers.length > 0) {
    throw new AppError(400, 'usage_based model does not support tiers');
  }
}

function validatePerSeat(config: Record<string, unknown>, tiers?: TierInput[]): void {
  if (
    typeof config.seat_price_cents !== 'number' ||
    !Number.isInteger(config.seat_price_cents) ||
    config.seat_price_cents <= 0
  ) {
    throw new AppError(
      400,
      'per_seat model requires config.seat_price_cents to be a positive integer',
    );
  }
  if (tiers && tiers.length > 0) {
    throw new AppError(400, 'per_seat model does not support tiers');
  }
}
