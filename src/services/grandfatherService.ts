// Authorized by HUB-1753 + HUB-1754 (E-V2-PP-4 S4/S5, HUB-1728, HUB-1701) —
// grandfather-aware renewal pricing + expiration reminder job.
//
// Per D-HUB-1701-04, grandfather is a signed cents delta applied to the base plan
// price for a fixed effective window. Ties broken by most-negative delta (best for
// tenant), then by created_at ASC. Never clamps below 0.

import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

export interface RenewalPriceResult {
  base_price_cents: number;
  grandfather_delta_cents: number;
  effective_price_cents: number;
  applied_grandfather_id: string | null;
}

/**
 * Calculate renewal price for a tenant × product on a given date.
 * See HUB-1753 for AC.
 */
export async function calculateRenewalPrice(
  tenantId: string,
  productId: string,
  basePriceCents: number,
  renewalDate: Date,
): Promise<RenewalPriceResult> {
  if (!Number.isInteger(basePriceCents) || basePriceCents < 0) {
    throw new AppError(400, 'basePriceCents must be a non-negative integer');
  }
  const pool = getPool();
  const dateStr = renewalDate.toISOString().slice(0, 10);
  // Grab all active grandfathers at this date; pick the one with most-negative delta,
  // tie-break by created_at ASC.
  const { rows } = await pool.query<{ id: string; delta_cents: number; created_at: string }>(
    `SELECT id, delta_cents, created_at
       FROM pricing_grandfathers
      WHERE tenant_id = $1 AND product_id = $2
        AND effective_from <= $3::date AND expires_at >= $3::date
      ORDER BY delta_cents ASC, created_at ASC
      LIMIT 1`,
    [tenantId, productId, dateStr],
  );
  if (rows.length === 0) {
    return {
      base_price_cents: basePriceCents,
      grandfather_delta_cents: 0,
      effective_price_cents: basePriceCents,
      applied_grandfather_id: null,
    };
  }
  const winner = rows[0]!;
  let effective = basePriceCents + winner.delta_cents;
  if (effective < 0) {
    logger.warn({ tenantId, productId, basePriceCents, delta: winner.delta_cents },
      'grandfather delta would produce negative price; clamping to 0');
    effective = 0;
  }
  return {
    base_price_cents: basePriceCents,
    grandfather_delta_cents: winner.delta_cents,
    effective_price_cents: effective,
    applied_grandfather_id: winner.id,
  };
}

/**
 * S5 — grandfather expiration reminder job. Selects grandfathers whose expires_at
 * is exactly 30 days from today (± 1 day window), and marks reminder_sent_at so
 * the same row isn't notified twice. Returns the affected IDs so the caller can
 * push notifications.
 */
export async function runGrandfatherExpirationReminders(): Promise<{
  notified_ids: string[];
  ran_at: string;
}> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE pricing_grandfathers
        SET reminder_sent_at = NOW()
      WHERE expires_at BETWEEN CURRENT_DATE + INTERVAL '30 days'
                           AND CURRENT_DATE + INTERVAL '31 days'
        AND (reminder_sent_at IS NULL OR reminder_sent_at < updated_at)
      RETURNING id`,
  );
  const ids = rows.map((r) => r.id);
  logger.info({ notified_count: ids.length, notified_ids: ids },
    'grandfather_expiration_reminders_run');
  return { notified_ids: ids, ran_at: new Date().toISOString() };
}

// ─── S2 upgrade evaluator (2-of-3 month rule) ───────────────────────────────

export interface UpgradeSuggestionRow {
  id: string;
  tenant_id: string;
  product_id: string;
  suggested_tier_index: number;
  projected_savings_cents: number;
}

/**
 * S2 — Evaluate whether a tenant's overage in ≥2 of the last 3 periods exceeds
 * the delta to the next tier. Upserts a row into upgrade_suggestions.
 *
 * Simplified for v0.2: caller provides the sequence of (period_start, overage_cents)
 * plus the next-tier delta. Pure evaluator; the DB write is separate.
 */
export function evaluateUpgrade2of3(
  overagePerPeriod: number[],
  nextTierDeltaCents: number,
): { should_suggest: boolean; matching_periods: number } {
  if (overagePerPeriod.length < 3) {
    return { should_suggest: false, matching_periods: 0 };
  }
  const last3 = overagePerPeriod.slice(-3);
  const matching = last3.filter((o) => o > nextTierDeltaCents).length;
  return { should_suggest: matching >= 2, matching_periods: matching };
}

/**
 * Persist an upgrade suggestion (respecting the 30-day dismissal cooldown).
 */
export async function upsertUpgradeSuggestion(
  tenantId: string,
  productId: string,
  suggestedTierIndex: number,
  basedOnPeriodFrom: Date,
  basedOnPeriodTo: Date,
  projectedSavingsCents: number,
): Promise<UpgradeSuggestionRow | null> {
  const pool = getPool();
  // Skip if dismissed and still within cooldown.
  const { rows: existing } = await pool.query<{ dismissed_at: string | null; cooldown_until: string | null }>(
    `SELECT dismissed_at, cooldown_until FROM upgrade_suggestions
      WHERE tenant_id = $1 AND product_id = $2`,
    [tenantId, productId],
  );
  if (existing[0]?.cooldown_until !== null && existing[0]?.cooldown_until !== undefined) {
    if (new Date(existing[0].cooldown_until).getTime() > Date.now()) {
      return null;
    }
  }

  const { rows } = await pool.query<UpgradeSuggestionRow>(
    `INSERT INTO upgrade_suggestions
       (tenant_id, product_id, suggested_tier_index, based_on_period_from,
        based_on_period_to, projected_savings_cents, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (tenant_id, product_id) DO UPDATE
       SET suggested_tier_index = EXCLUDED.suggested_tier_index,
           based_on_period_from = EXCLUDED.based_on_period_from,
           based_on_period_to = EXCLUDED.based_on_period_to,
           projected_savings_cents = EXCLUDED.projected_savings_cents,
           computed_at = NOW(),
           dismissed_at = NULL,
           cooldown_until = NULL
     RETURNING id, tenant_id, product_id, suggested_tier_index, projected_savings_cents`,
    [
      tenantId, productId, suggestedTierIndex,
      basedOnPeriodFrom.toISOString().slice(0, 10),
      basedOnPeriodTo.toISOString().slice(0, 10),
      projectedSavingsCents,
    ],
  );
  return rows[0]!;
}

/**
 * Dismiss an active upgrade suggestion. Sets dismissed_at + 30-day cooldown.
 * Returns the cooldown_until timestamp, or null if there was no active suggestion.
 */
export async function dismissUpgradeSuggestion(
  tenantId: string,
  productId: string,
): Promise<{ cooldown_until: string } | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ cooldown_until: string }>(
    `UPDATE upgrade_suggestions
        SET dismissed_at = NOW(),
            cooldown_until = NOW() + INTERVAL '30 days'
      WHERE tenant_id = $1 AND product_id = $2 AND dismissed_at IS NULL
      RETURNING cooldown_until`,
    [tenantId, productId],
  );
  return rows[0] ?? null;
}

export async function getUpgradeSuggestion(
  tenantId: string,
  productId: string,
): Promise<UpgradeSuggestionRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<UpgradeSuggestionRow>(
    `SELECT id, tenant_id, product_id, suggested_tier_index, projected_savings_cents
       FROM upgrade_suggestions
      WHERE tenant_id = $1 AND product_id = $2 AND dismissed_at IS NULL`,
    [tenantId, productId],
  );
  return rows[0] ?? null;
}
