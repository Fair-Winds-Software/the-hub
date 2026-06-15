// Authorized by HUB-671 — aggregatePeriodCosts() and getPeriodCostSummary() service functions
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';

export interface BillingPeriodCostRow {
  tenant_id: string;
  product_id: string;
  period_start: Date;
  period_end: Date;
  total_units: number;
  total_cost_cents: number;
  event_count: number;
  late_event_count: number;
  aggregated_at: Date;
}

export async function aggregatePeriodCosts(
  tenantId: string,
  productId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<void> {
  // TODO-D-DEF-003: if pre-aggregated granularity decided, this function may write directly; per-event at v1
  const pool = getPool();
  const client = await pool.connect();

  try {
    const { rows } = await client.query<{
      total_cost_cents: string;
      total_units: string;
      event_count: string;
      late_event_count: string;
    }>(
      `SELECT
         COALESCE(SUM(cost_cents), 0)                          AS total_cost_cents,
         COALESCE(SUM(unit_count), 0)                          AS total_units,
         COUNT(*)                                               AS event_count,
         COUNT(*) FILTER (WHERE ingested_late = true)          AS late_event_count
       FROM cost_ledger
       WHERE tenant_id  = $1
         AND product_id = $2
         AND occurred_at >= $3
         AND occurred_at  < $4`,
      [tenantId, productId, periodStart, periodEnd],
    );

    const row = rows[0]!;
    const totalCostCents = parseInt(row.total_cost_cents, 10);
    const totalUnits = parseInt(row.total_units, 10);
    const eventCount = parseInt(row.event_count, 10);
    const lateEventCount = parseInt(row.late_event_count, 10);

    await client.query(
      `INSERT INTO billing_period_costs
         (tenant_id, product_id, period_start, period_end,
          total_cost_cents, total_units, event_count, late_event_count, aggregated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (tenant_id, product_id, period_start) DO UPDATE
         SET total_cost_cents = EXCLUDED.total_cost_cents,
             total_units      = EXCLUDED.total_units,
             event_count      = EXCLUDED.event_count,
             late_event_count = EXCLUDED.late_event_count,
             aggregated_at    = NOW()`,
      [tenantId, productId, periodStart, periodEnd,
        totalCostCents, totalUnits, eventCount, lateEventCount],
    );

    logger.info(
      { tenantId, productId, period_start: periodStart, total_cost_cents: totalCostCents, event_count: eventCount, late_event_count: lateEventCount },
      'period_cost_aggregation_complete',
    );
  } finally {
    client.release();
  }
}

export async function getPeriodCostSummary(
  tenantId: string,
  productId: string,
  periodStart: Date,
): Promise<BillingPeriodCostRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<BillingPeriodCostRow>(
    `SELECT tenant_id, product_id, period_start, period_end,
            total_units, total_cost_cents, event_count, late_event_count, aggregated_at
       FROM billing_period_costs
      WHERE tenant_id  = $1
        AND product_id = $2
        AND period_start = $3`,
    [tenantId, productId, periodStart],
  );

  logger.debug({ tenantId, productId, period_start: periodStart }, 'getPeriodCostSummary');
  return rows[0] ?? null;
}
