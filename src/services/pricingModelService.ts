// Authorized by HUB-580 — activatePricingModel; pg transaction; Redis cache update + pub/sub invalidation
// Authorized by HUB-581 — getActivePricingModel (Redis-first); getPricingModelHistory (paginated, DB-only)
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';
import { getRedisClient } from '../redis/client.js';
import { validatePricingModelConfig } from '../lib/pricingModelValidation.js';
import type { TierInput } from '../lib/pricingModelValidation.js';

export interface TierRow {
  tier_id: string;
  model_id: string;
  tier_order: number;
  up_to_units: number | null;
  unit_price_cents: number;
  flat_fee_cents: number;
}

export interface PricingModelRow {
  model_id: string;
  product_id: string;
  model_type: string;
  currency: string;
  config: Record<string, unknown>;
  active: boolean;
  activated_at: string | null;
  deprecated_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  tiers?: TierRow[];
}

export interface PricingModelHistoryResult {
  data: PricingModelRow[];
  limit: number;
  offset: number;
}

function cacheKey(productId: string): string {
  return `hub:pricing:active:${productId}`;
}

function toISOOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// ── activatePricingModel ──────────────────────────────────────────────────────

export async function activatePricingModel(
  productId: string,
  modelType: string,
  currency: string,
  config: Record<string, unknown>,
  tiers: TierInput[] | undefined,
  operatorId: string,
): Promise<PricingModelRow> {
  validatePricingModelConfig(modelType, config, tiers);

  const pool = getPool();
  const client = await pool.connect();
  let newModel: PricingModelRow;

  try {
    await client.query('BEGIN');

    const { rows: productRows } = await client.query<{ id: string }>(
      'SELECT id FROM products WHERE id = $1 FOR UPDATE',
      [productId],
    );
    if (productRows.length === 0) throw new AppError(404, 'Product not found');

    await client.query(
      `UPDATE pricing_models
       SET active = false, deprecated_at = NOW()
       WHERE product_id = $1 AND active = true`,
      [productId],
    );

    const { rows: modelRows } = await client.query<{
      id: string;
      product_id: string;
      model_type: string;
      currency: string;
      config: Record<string, unknown>;
      active: boolean;
      activated_at: Date | null;
      deprecated_at: Date | null;
      created_by: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO pricing_models (product_id, model_type, currency, config, active, activated_at, created_by)
       VALUES ($1, $2, $3, $4, true, NOW(), $5)
       RETURNING *`,
      [productId, modelType, currency, JSON.stringify(config), operatorId],
    );

    const row = modelRows[0]!;
    const insertedTiers: TierRow[] = [];

    if (tiers && tiers.length > 0) {
      for (const tier of tiers) {
        const { rows: tierRows } = await client.query<{
          id: string;
          model_id: string;
          tier_order: number;
          up_to_units: number | null;
          unit_price_cents: number;
          flat_fee_cents: number;
        }>(
          `INSERT INTO price_tiers (model_id, tier_order, up_to_units, unit_price_cents, flat_fee_cents)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [row.id, tier.tier_order, tier.up_to_units, tier.unit_price_cents, tier.flat_fee_cents],
        );
        const tr = tierRows[0]!;
        insertedTiers.push({
          tier_id: tr.id,
          model_id: tr.model_id,
          tier_order: tr.tier_order,
          up_to_units: tr.up_to_units,
          unit_price_cents: tr.unit_price_cents,
          flat_fee_cents: tr.flat_fee_cents,
        });
      }
    }

    await client.query('COMMIT');

    newModel = {
      model_id: row.id,
      product_id: row.product_id,
      model_type: row.model_type,
      currency: row.currency,
      config: row.config,
      active: row.active,
      activated_at: toISOOrNull(row.activated_at),
      deprecated_at: toISOOrNull(row.deprecated_at),
      created_by: row.created_by,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      tiers: insertedTiers,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  logger.info({ productId, modelType, operatorId }, 'Pricing model activated');

  try {
    const redis = getRedisClient();
    await redis.set(cacheKey(productId), JSON.stringify(newModel));
    await redis.publish(
      `hub:pricing:active:${productId}`,
      JSON.stringify({ type: 'pricing_model_changed', productId }),
    );
  } catch (err) {
    logger.warn({ err, productId }, 'Pricing model cache update failed — DB is authoritative');
  }

  return newModel;
}

// ── getActivePricingModel ─────────────────────────────────────────────────────

export async function getActivePricingModel(productId: string): Promise<PricingModelRow | null> {
  try {
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey(productId));
    if (cached) {
      return JSON.parse(cached) as PricingModelRow;
    }
  } catch (err) {
    logger.warn({ err, productId }, 'Redis read failed for pricing model — falling back to DB');
  }

  const pool = getPool();
  const { rows: modelRows } = await pool.query<{
    id: string;
    product_id: string;
    model_type: string;
    currency: string;
    config: Record<string, unknown>;
    active: boolean;
    activated_at: Date | null;
    deprecated_at: Date | null;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT * FROM pricing_models WHERE product_id = $1 AND active = true LIMIT 1`,
    [productId],
  );

  if (modelRows.length === 0) return null;

  const row = modelRows[0]!;
  const { rows: tierRows } = await pool.query<{
    id: string;
    model_id: string;
    tier_order: number;
    up_to_units: number | null;
    unit_price_cents: number;
    flat_fee_cents: number;
  }>(
    `SELECT * FROM price_tiers WHERE model_id = $1 ORDER BY tier_order ASC`,
    [row.id],
  );

  const result: PricingModelRow = {
    model_id: row.id,
    product_id: row.product_id,
    model_type: row.model_type,
    currency: row.currency,
    config: row.config,
    active: row.active,
    activated_at: toISOOrNull(row.activated_at),
    deprecated_at: toISOOrNull(row.deprecated_at),
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    tiers: tierRows.map((t) => ({
      tier_id: t.id,
      model_id: t.model_id,
      tier_order: t.tier_order,
      up_to_units: t.up_to_units,
      unit_price_cents: t.unit_price_cents,
      flat_fee_cents: t.flat_fee_cents,
    })),
  };

  try {
    const redis = getRedisClient();
    await redis.set(cacheKey(productId), JSON.stringify(result));
  } catch (err) {
    logger.warn({ err, productId }, 'Redis write failed for pricing model cache');
  }

  return result;
}

// ── getPricingModelHistory ────────────────────────────────────────────────────

export async function getPricingModelHistory(
  productId: string,
  limit: number,
  offset: number,
): Promise<PricingModelHistoryResult> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    product_id: string;
    model_type: string;
    currency: string;
    config: Record<string, unknown>;
    active: boolean;
    activated_at: Date | null;
    deprecated_at: Date | null;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT * FROM pricing_models
     WHERE product_id = $1
     ORDER BY activated_at DESC NULLS LAST, created_at DESC
     LIMIT $2 OFFSET $3`,
    [productId, limit, offset],
  );

  const data: PricingModelRow[] = rows.map((row) => ({
    model_id: row.id,
    product_id: row.product_id,
    model_type: row.model_type,
    currency: row.currency,
    config: row.config,
    active: row.active,
    activated_at: toISOOrNull(row.activated_at),
    deprecated_at: toISOOrNull(row.deprecated_at),
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));

  return { data, limit, offset };
}
