// Authorized by HUB-1763 + HUB-1764 (E-V2-PP-5 S4/S5, HUB-1729, HUB-1701) —
// Quarterly cadence orchestrator + monthly quota sub-unlock scheduler.
//
// Per HUB-1762 spike closure (D-HUB-1701-05): quarterly = 3 calendar months via
// Stripe native `interval='month', interval_count=3` (existing INTERVAL_MAP.quarter
// in planChangeService.ts). This service does NOT emit Stripe subscriptions —
// planChangeService already handles that. This service provides:
//   1) getCurrentQuarterlyCycle() — cycle math for any given tenant+plan today
//   2) runQuotaSubUnlock() — nightly job that inserts entitlement grants for the
//      current cycle position (1|2|3) per plan_quota_sub_unlocks rows
//   3) getQuarterlyCyclePreview() — read-only projection for the tenant billing FE

import crypto from 'node:crypto';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

export interface QuarterlyCycleInfo {
  cycle_id: string;
  cycle_start: string; // YYYY-MM-DD
  cycle_end: string;   // YYYY-MM-DD (last day of month 3, exclusive-ish)
  cycle_position: 1 | 2 | 3;
  month_start: string;
  month_end: string;
  days_remaining_in_cycle: number;
  days_until_next_unlock: number | null;
}

// Deterministic UUID from tenant + cycle_start so re-runs of the scheduler
// hit ON CONFLICT DO NOTHING instead of double-granting.
function computeCycleId(tenantId: string, cycleStartISO: string): string {
  const hash = crypto.createHash('md5').update(`${tenantId}|${cycleStartISO}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

function toISODate(d: Date): string { return d.toISOString().slice(0, 10); }

/**
 * Given a subscription anchor date (period_start) and today, compute the current
 * quarterly cycle info. Cycle = 3 calendar months anchored to the anchor day-of-month.
 *
 * See HUB-1763 for AC.
 */
export function getCurrentQuarterlyCycle(anchorDate: Date, today: Date, tenantId: string): QuarterlyCycleInfo {
  if (today.getTime() < anchorDate.getTime()) {
    throw new AppError(400, 'today cannot be before anchorDate');
  }
  // How many full cycles have elapsed since anchor?
  const monthsElapsed =
    (today.getUTCFullYear() - anchorDate.getUTCFullYear()) * 12 +
    (today.getUTCMonth() - anchorDate.getUTCMonth()) -
    (today.getUTCDate() < anchorDate.getUTCDate() ? 1 : 0);
  const cyclesElapsed = Math.floor(monthsElapsed / 3);
  const positionInCycle = (monthsElapsed % 3) + 1; // 1 | 2 | 3

  const cycleStart = addMonths(anchorDate, cyclesElapsed * 3);
  const cycleEnd = addMonths(cycleStart, 3);
  const monthStart = addMonths(cycleStart, positionInCycle - 1);
  const monthEnd = addMonths(monthStart, 1);

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.max(0, Math.ceil((cycleEnd.getTime() - today.getTime()) / msPerDay));
  const daysUntilNextUnlock = positionInCycle < 3
    ? Math.max(0, Math.ceil((monthEnd.getTime() - today.getTime()) / msPerDay))
    : null;

  return {
    cycle_id: computeCycleId(tenantId, toISODate(cycleStart)),
    cycle_start: toISODate(cycleStart),
    cycle_end: toISODate(cycleEnd),
    cycle_position: positionInCycle as 1 | 2 | 3,
    month_start: toISODate(monthStart),
    month_end: toISODate(monthEnd),
    days_remaining_in_cycle: daysRemaining,
    days_until_next_unlock: daysUntilNextUnlock,
  };
}

interface QuarterlyTenantRow {
  tenant_id: string;
  plan_id: string;
  current_period_start: Date;
}

/**
 * S5 — nightly quota sub-unlock scheduler. For every active quarterly subscription,
 * looks up plan_quota_sub_unlocks and inserts entitlement grants for the current
 * cycle position. Idempotent via ON CONFLICT (tenant, dimension, cycle_id, position).
 *
 * See HUB-1764 for AC.
 */
export async function runQuotaSubUnlock(now: Date = new Date()): Promise<{
  tenants_processed: number;
  grants_written: number;
}> {
  const pool = getPool();
  // Select tenants on quarterly plans with sub-unlocks declared.
  const { rows: tenants } = await pool.query<QuarterlyTenantRow>(
    `SELECT DISTINCT ss.tenant_id, ss.plan_id, ss.current_period_start
       FROM stripe_subscriptions ss
       JOIN plans p ON p.id = ss.plan_id
      WHERE ss.status = 'active'
        AND p.billing_interval = 'quarter'
        AND p.active = true
        AND EXISTS (SELECT 1 FROM plan_quota_sub_unlocks q WHERE q.plan_id = p.id)`,
  );

  let grantsWritten = 0;
  for (const tenant of tenants) {
    const cycle = getCurrentQuarterlyCycle(new Date(tenant.current_period_start), now, tenant.tenant_id);
    const { rows: subUnlocks } = await pool.query<{ dimension_key: string; per_month_quantity: number }>(
      `SELECT dimension_key, per_month_quantity
         FROM plan_quota_sub_unlocks
        WHERE plan_id = $1`,
      [tenant.plan_id],
    );
    for (const su of subUnlocks) {
      const { rowCount } = await pool.query(
        `INSERT INTO quarterly_cycle_grants
           (tenant_id, plan_id, dimension_key, quantity, cycle_id, cycle_position, cycle_start)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date)
         ON CONFLICT (tenant_id, dimension_key, cycle_id, cycle_position) DO NOTHING`,
        [
          tenant.tenant_id, tenant.plan_id, su.dimension_key, su.per_month_quantity,
          cycle.cycle_id, cycle.cycle_position, cycle.cycle_start,
        ],
      );
      grantsWritten += rowCount ?? 0;
    }
  }

  logger.info({ tenants_processed: tenants.length, grants_written: grantsWritten },
    'runQuotaSubUnlock completed');
  return { tenants_processed: tenants.length, grants_written: grantsWritten };
}

export interface QuarterlyCyclePreview {
  cycle: QuarterlyCycleInfo;
  dimensions: Array<{
    dimension_key: string;
    per_month_quantity: number;
    total_this_cycle: number;
    unlocked_to_date: number;
  }>;
}

/**
 * Read-only preview for the tenant billing surface (HUB-1767 S8 backing data).
 */
export async function getQuarterlyCyclePreview(
  tenantId: string,
  planId: string,
  now: Date = new Date(),
): Promise<QuarterlyCyclePreview | null> {
  const pool = getPool();
  const { rows: subs } = await pool.query<{ current_period_start: Date }>(
    `SELECT ss.current_period_start
       FROM stripe_subscriptions ss
       JOIN plans p ON p.id = ss.plan_id
      WHERE ss.tenant_id = $1 AND ss.plan_id = $2 AND ss.status = 'active'
        AND p.billing_interval = 'quarter'`,
    [tenantId, planId],
  );
  if (subs.length === 0) return null;
  const anchor = new Date(subs[0]!.current_period_start);
  const cycle = getCurrentQuarterlyCycle(anchor, now, tenantId);

  const { rows: subUnlocks } = await pool.query<{ dimension_key: string; per_month_quantity: number }>(
    `SELECT dimension_key, per_month_quantity FROM plan_quota_sub_unlocks WHERE plan_id = $1`,
    [planId],
  );

  const dims = subUnlocks.map((su) => ({
    dimension_key: su.dimension_key,
    per_month_quantity: su.per_month_quantity,
    total_this_cycle: su.per_month_quantity * 3,
    unlocked_to_date: su.per_month_quantity * cycle.cycle_position,
  }));
  return { cycle, dimensions: dims };
}
