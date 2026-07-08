// Authorized by HUB-1765 (E-V2-PP-5 S6, HUB-1729, HUB-1701) — annual cadence
// renewal + grandfather integration. Consumes calculateRenewalPrice from the
// E-V2-PP-4 grandfatherService.
//
// Delivery scope: preview + T-30 scheduler that computes upcoming annual
// renewals and logs any grandfather adjustments. Actual Stripe invoice mutation
// is left to the existing price_override path (created by an operator or a
// v0.3 automation) — this service surfaces the numbers correctly.

import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import { calculateRenewalPrice, type RenewalPriceResult } from './grandfatherService.js';
import logger from '../lib/logger.js';

export interface AnnualRenewalPreview {
  tenant_id: string;
  product_id: string;
  plan_id: string;
  renewal_date: string; // YYYY-MM-DD
  pricing: RenewalPriceResult;
  invoice_line_description: string;
}

// Annual cycle = 365 days (or 366 for leap-boundary). We compute the renewal
// date as the anchor + 1 UTC year — JavaScript's Date arithmetic handles leap
// years correctly by returning the same month-day one calendar year later.
export function computeAnnualRenewalDate(anchorDate: Date): Date {
  const next = new Date(anchorDate);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

/**
 * Preview a single annual renewal — computes the effective invoice amount using
 * the E-V2-PP-4 grandfather CTE. Callers may use this for the renewal-preview UI
 * (HUB-1757) or for the T-30 scheduler below.
 *
 * See HUB-1765 for AC.
 */
export async function previewAnnualRenewal(
  tenantId: string,
  productId: string,
  planId: string,
  renewalDate: Date,
): Promise<AnnualRenewalPreview> {
  const pool = getPool();
  const { rows: planRows } = await pool.query<{ unit_amount_cents: string | number; billing_interval: string }>(
    `SELECT unit_amount_cents, billing_interval FROM plans WHERE id = $1 AND active = true`,
    [planId],
  );
  if (!planRows[0]) throw new AppError(404, 'Plan not found or inactive');
  if (planRows[0].billing_interval !== 'year') {
    throw new AppError(400, 'previewAnnualRenewal requires plan.billing_interval = year');
  }
  // pg returns BIGINT columns as strings; coerce so calculateRenewalPrice's
  // Number.isInteger guard passes.
  const basePriceCents = Number(planRows[0].unit_amount_cents);
  const pricing = await calculateRenewalPrice(tenantId, productId, basePriceCents, renewalDate);

  // Compose the invoice line description; if grandfather applied, add a sub-line.
  let desc = `Annual renewal — ${(basePriceCents / 100).toFixed(2)}`;
  if (pricing.applied_grandfather_id !== null && pricing.grandfather_delta_cents !== 0) {
    const sign = pricing.grandfather_delta_cents < 0 ? 'discount' : 'surcharge';
    const abs = Math.abs(pricing.grandfather_delta_cents) / 100;
    desc += ` (Grandfathered ${sign}: ${pricing.grandfather_delta_cents < 0 ? '-' : '+'}$${abs.toFixed(2)})`;
  }

  return {
    tenant_id: tenantId,
    product_id: productId,
    plan_id: planId,
    renewal_date: renewalDate.toISOString().slice(0, 10),
    pricing,
    invoice_line_description: desc,
  };
}

/**
 * T-30 nightly scheduler — scans annual subscriptions renewing in the next 30
 * days, computes the effective price with grandfather applied, and logs the
 * preview so an operator (or a v0.3 automation) can act on it. Returns the
 * list of adjusted renewals for the operator dashboard.
 */
export async function scanUpcomingAnnualRenewals(now: Date = new Date()): Promise<{
  scanned: number;
  grandfather_adjustments: AnnualRenewalPreview[];
}> {
  const pool = getPool();
  const nowISO = now.toISOString();
  const { rows } = await pool.query<{
    tenant_id: string; product_id: string; plan_id: string; current_period_end: Date;
  }>(
    `SELECT ss.tenant_id, ss.product_id, ss.plan_id, ss.current_period_end
       FROM stripe_subscriptions ss
       JOIN plans p ON p.id = ss.plan_id
      WHERE ss.status = 'active'
        AND p.billing_interval = 'year'
        AND ss.current_period_end BETWEEN $1::timestamptz AND $1::timestamptz + INTERVAL '30 days'`,
    [nowISO],
  );
  const adjustments: AnnualRenewalPreview[] = [];
  for (const r of rows) {
    const preview = await previewAnnualRenewal(
      r.tenant_id, r.product_id, r.plan_id, new Date(r.current_period_end),
    );
    if (preview.pricing.applied_grandfather_id !== null) {
      adjustments.push(preview);
      logger.info({
        tenant_id: r.tenant_id, product_id: r.product_id,
        applied_grandfather_id: preview.pricing.applied_grandfather_id,
        effective_price_cents: preview.pricing.effective_price_cents,
      }, 'annual renewal T-30 grandfather adjustment');
    }
  }
  return { scanned: rows.length, grandfather_adjustments: adjustments };
}
