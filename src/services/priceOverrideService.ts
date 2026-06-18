// Authorized by HUB-1483 — setPriceOverride() + getCurrentOverride(); effective-dating (SCHEMA-021)
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

export interface PriceOverrideDef {
  override_amount_cents: number;
  currency?: string;
  reason?: string;
  applied_by?: string;
}

export interface PriceOverrideRow {
  id: string;
  tenant_id: string;
  product_id: string;
  plan_id: string;
  override_price_cents: number;
  effective_from: Date;
  effective_to: Date | null;
  reason: string;
  applied_by: string;
  delta_data: unknown | null;
  created_at: Date;
}

// Sets a price override for a tenant+product+plan using the effective-dating pattern (SCHEMA-021).
// Closes any currently active override and opens a new one in a single transaction.
export async function setPriceOverride(
  tenantId: string,
  productId: string,
  planId: string,
  def: PriceOverrideDef,
): Promise<PriceOverrideRow> {
  if (def.override_amount_cents < 0) {
    throw new AppError(400, 'override_amount_cents must be non-negative');
  }

  const pool = getPool();

  const { rows: planRows } = await pool.query<{ id: string }>(
    'SELECT id FROM plans WHERE id = $1',
    [planId],
  );
  if (!planRows[0]) throw new AppError(404, 'Plan not found');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Close any currently active override for this tenant+product+plan
    await client.query(
      `UPDATE price_overrides
       SET effective_to = NOW()
       WHERE tenant_id = $1 AND product_id = $2 AND plan_id = $3
         AND effective_from <= NOW()
         AND (effective_to IS NULL OR effective_to > NOW())`,
      [tenantId, productId, planId],
    );

    const { rows } = await client.query<PriceOverrideRow>(
      `INSERT INTO price_overrides
         (tenant_id, product_id, plan_id, override_price_cents, effective_from, reason, applied_by)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6)
       RETURNING *`,
      [
        tenantId,
        productId,
        planId,
        def.override_amount_cents,
        def.reason ?? '',
        def.applied_by ?? '',
      ],
    );

    await client.query('COMMIT');
    return rows[0]!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Returns the currently active price override for a tenant+product+plan, or null if none.
// Uses time-range only (no active flag) per SCHEMA-021.
export async function getCurrentOverride(
  tenantId: string,
  productId: string,
  planId: string,
): Promise<PriceOverrideRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<PriceOverrideRow>(
    `SELECT * FROM price_overrides
     WHERE tenant_id = $1 AND product_id = $2 AND plan_id = $3
       AND effective_from <= NOW()
       AND (effective_to IS NULL OR effective_to > NOW())
     ORDER BY effective_from DESC
     LIMIT 1`,
    [tenantId, productId, planId],
  );
  return rows[0] ?? null;
}
