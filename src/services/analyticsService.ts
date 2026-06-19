// Authorized by HUB-1520 — analyticsService: getUsageAnalytics + getBillingAnalytics over billing_period_costs
// Authorized by HUB-47 FVL — M1: add recovery_count to BillingRow per FR-37-02

import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

const MAX_RANGE_DAYS = 90;
const MAX_LIMIT = 200;
const STALENESS_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export interface UsageAnalyticsParams {
  tenantId?: string;
  productId?: string;
  from: Date;
  to: Date;
  limit: number;
  cursor?: string;
}

export interface UsageRow {
  tenant_id: string;
  product_id: string;
  period_start: string;
  period_end: string;
  event_count: number;
  total_cost_cents: number;
}

export interface UsageAnalyticsResult {
  from: string;
  to: string;
  generated_at: string;
  stale: boolean;
  row_count: number;
  next_cursor: string | null;
  data: UsageRow[];
}

export interface BillingAnalyticsParams {
  productId: string;
  from: Date;
  to: Date;
}

export interface BillingRow {
  product_id: string;
  period: string;
  active_subscriptions: number;
  mrr_cents: number;
  freeze_count: number;
  recovery_count: number;
}

export interface BillingAnalyticsResult {
  from: string;
  to: string;
  generated_at: string;
  stale: boolean;
  row_count: number;
  next_cursor: null;
  data: BillingRow[];
}

interface UsageCursorPayload {
  period_start: string;
  tenant_id: string;
}

function encodeUsageCursor(period_start: string, tenant_id: string): string {
  return Buffer.from(JSON.stringify({ period_start, tenant_id })).toString('base64url');
}

function decodeUsageCursor(raw: string): UsageCursorPayload {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as UsageCursorPayload;
  } catch {
    throw new AppError(400, 'Invalid cursor');
  }
}

function validateRange(from: Date, to: Date): void {
  const rangeDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new AppError(400, 'Time range must not exceed 90 days');
  }
}

async function checkStaleness(from: Date): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ last_aggregated: Date | null }>(
    `SELECT MAX(aggregated_at) AS last_aggregated
       FROM billing_period_costs
      WHERE aggregated_at >= $1`,
    [from],
  );
  const lastAggregated = rows[0]?.last_aggregated;
  if (!lastAggregated) return true;
  return Date.now() - lastAggregated.getTime() > STALENESS_THRESHOLD_MS;
}

export async function getUsageAnalytics(params: UsageAnalyticsParams): Promise<UsageAnalyticsResult> {
  validateRange(params.from, params.to);

  const limit = Math.min(params.limit, MAX_LIMIT);
  const conditions: string[] = ['bpc.period_start >= $1', 'bpc.period_end <= $2'];
  const values: unknown[] = [params.from, params.to];
  let idx = 3;

  if (params.tenantId) {
    conditions.push(`bpc.tenant_id = $${idx++}`);
    values.push(params.tenantId);
  }
  if (params.productId) {
    conditions.push(`bpc.product_id = $${idx++}`);
    values.push(params.productId);
  }
  if (params.cursor) {
    const { period_start, tenant_id } = decodeUsageCursor(params.cursor);
    conditions.push(
      `(bpc.period_start, bpc.tenant_id::text) < ($${idx++}::timestamptz, $${idx++})`,
    );
    values.push(period_start, tenant_id);
  }

  const where = conditions.join(' AND ');
  const fetchLimit = limit + 1;

  const pool = getPool();
  const [{ rows }, stale] = await Promise.all([
    pool.query<UsageRow>(
      `SELECT bpc.tenant_id::text AS tenant_id,
              bpc.product_id::text AS product_id,
              bpc.period_start::text AS period_start,
              bpc.period_end::text AS period_end,
              bpc.event_count,
              bpc.total_cost_cents
         FROM billing_period_costs bpc
        WHERE ${where}
        ORDER BY bpc.period_start DESC, bpc.tenant_id DESC
        LIMIT $${idx}`,
      [...values, fetchLimit],
    ),
    checkStaleness(params.from),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const next_cursor =
    hasMore && last ? encodeUsageCursor(last.period_start, last.tenant_id) : null;

  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    generated_at: new Date().toISOString(),
    stale,
    row_count: data.length,
    next_cursor,
    data,
  };
}

export async function getBillingAnalytics(params: BillingAnalyticsParams): Promise<BillingAnalyticsResult> {
  validateRange(params.from, params.to);

  const pool = getPool();
  const [costRows, subRow, freezeRow, recoveryRow, stale] = await Promise.all([
    // MRR per period: sum total_cost_cents across all tenants for this product
    pool.query<{ period_start: string; period_end: string; mrr_cents: string }>(
      `SELECT period_start::text AS period_start,
              period_end::text AS period_end,
              SUM(total_cost_cents)::bigint AS mrr_cents
         FROM billing_period_costs
        WHERE product_id = $1
          AND period_start >= $2
          AND period_end <= $3
        GROUP BY period_start, period_end
        ORDER BY period_start DESC`,
      [params.productId, params.from, params.to],
    ),
    // Active subscription count for this product
    pool.query<{ active_subscriptions: string }>(
      `SELECT COUNT(*)::bigint AS active_subscriptions
         FROM stripe_subscriptions
        WHERE product_id = $1
          AND status = 'active'`,
      [params.productId],
    ),
    // Freeze count: join through product_registrations since licenses.product_id → product_registrations.id
    pool.query<{ freeze_count: string }>(
      `SELECT COUNT(*)::bigint AS freeze_count
         FROM licenses l
         JOIN product_registrations pr ON pr.id = l.product_id
        WHERE pr.product_id = $1
          AND l.status = 'suspended'
          AND l.reason = 'FREEZE'`,
      [params.productId],
    ),
    // Recovery count: licenses now active that were previously frozen (suspended_at set),
    // where the recovery (updated_at) falls within the queried billing period.
    pool.query<{ recovery_count: string }>(
      `SELECT COUNT(*)::bigint AS recovery_count
         FROM licenses l
         JOIN product_registrations pr ON pr.id = l.product_id
        WHERE pr.product_id = $1
          AND l.status = 'active'
          AND l.suspended_at IS NOT NULL
          AND l.updated_at >= $2
          AND l.updated_at <= $3`,
      [params.productId, params.from, params.to],
    ),
    checkStaleness(params.from),
  ]);

  const activeSubscriptions = parseInt(subRow.rows[0]?.active_subscriptions ?? '0', 10);
  const freezeCount = parseInt(freezeRow.rows[0]?.freeze_count ?? '0', 10);
  const recoveryCount = parseInt(recoveryRow.rows[0]?.recovery_count ?? '0', 10);

  const data: BillingRow[] = costRows.rows.map((row) => ({
    product_id: params.productId,
    period: row.period_start,
    active_subscriptions: activeSubscriptions,
    mrr_cents: Math.round(parseInt(row.mrr_cents ?? '0', 10)),
    freeze_count: freezeCount,
    recovery_count: recoveryCount,
  }));

  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    generated_at: new Date().toISOString(),
    stale,
    row_count: data.length,
    next_cursor: null,
    data,
  };
}
