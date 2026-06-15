// Authorized by HUB-643 — evaluateMargin(); margin calculation, audit record, below_floor BullMQ publication; D-001
import { getPool } from '../db/pool.js';
import logger from '../lib/logger.js';
import { getAlertsQueue } from '../queues/index.js';

export interface MarginEvaluationResult {
  tenant_id: string;
  product_id: string;
  evaluated_at: string;
  revenue_cents: number;
  cost_cents: number;
  margin_percentage: number;
  below_floor: boolean;
}

// TODO: Period definition is current calendar month (UTC). Make configurable when billing cycle is formalized.
function currentMonthBounds(): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date();
  return { periodStart, periodEnd };
}

export async function evaluateMargin(
  tenantId: string,
  productId: string,
): Promise<MarginEvaluationResult> {
  const pool = getPool();
  const { periodStart, periodEnd } = currentMonthBounds();

  logger.debug({ tenantId, productId, periodStart, periodEnd }, 'evaluateMargin start');

  // Revenue: SUM of amount_paid on invoices whose period_start falls within current month
  const { rows: revenueRows } = await pool.query<{ revenue: string }>(
    `SELECT COALESCE(SUM(amount_paid), 0)::text AS revenue
       FROM invoices
      WHERE tenant_id = $1
        AND product_id = $2
        AND period_start >= $3
        AND period_start < $4`,
    [tenantId, productId, periodStart.toISOString(), periodEnd.toISOString()],
  );

  // Cost: SUM of cost_cents on cost_ledger within same period
  const { rows: costRows } = await pool.query<{ cost: string }>(
    `SELECT COALESCE(SUM(cost_cents), 0)::text AS cost
       FROM cost_ledger
      WHERE tenant_id = $1
        AND product_id = $2
        AND occurred_at >= $3
        AND occurred_at < $4`,
    [tenantId, productId, periodStart.toISOString(), periodEnd.toISOString()],
  );

  const revenue_cents = parseInt(revenueRows[0]?.revenue ?? '0', 10);
  const cost_cents = parseInt(costRows[0]?.cost ?? '0', 10);

  // Zero-revenue guard — D-001: never divide by zero
  const margin_percentage =
    revenue_cents === 0
      ? 0
      : Math.round(((revenue_cents - cost_cents) / revenue_cents) * 100 * 100) / 100;

  // Margin config lookup — null means no config → alert disabled
  const { rows: configRows } = await pool.query<{
    floor_percentage: string;
    enabled: boolean;
  }>(
    `SELECT floor_percentage, enabled FROM margin_configs WHERE product_id = $1`,
    [productId],
  );

  const config = configRows[0] ?? null;
  const floorPct = config ? parseFloat(config.floor_percentage) : null;
  const below_floor =
    floorPct !== null && config!.enabled && margin_percentage < floorPct;

  const evaluatedAt = new Date().toISOString();

  await pool.query(
    `INSERT INTO margin_evaluations
       (tenant_id, product_id, evaluated_at, revenue_cents, cost_cents, margin_percentage, below_floor)
     VALUES ($1, $2, NOW(), $3, $4, $5, $6)`,
    [tenantId, productId, revenue_cents, cost_cents, margin_percentage, below_floor],
  );

  // D-001 invariant: publish alert event only — never suspend, freeze, or cancel anything
  if (below_floor && floorPct !== null) {
    try {
      const alertsQueue = getAlertsQueue();
      await alertsQueue.add('below_floor', {
        tenantId,
        productId,
        margin_percentage,
        floor_percentage: floorPct,
        evaluated_at: evaluatedAt,
      });
      logger.info({ tenantId, productId, margin_percentage, floor_percentage: floorPct }, 'below_floor alert published');
    } catch (err) {
      logger.error({ err, tenantId, productId }, 'Failed to publish below_floor alert — evaluation recorded');
    }
  }

  logger.debug({ tenantId, productId, margin_percentage, below_floor }, 'evaluateMargin complete');

  return {
    tenant_id: tenantId,
    product_id: productId,
    evaluated_at: evaluatedAt,
    revenue_cents,
    cost_cents,
    margin_percentage,
    below_floor,
  };
}
