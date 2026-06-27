// Authorized by HUB-1700 (E-BE-1 S23) — portfolio-wide products aggregator. Single SQL
// (CTEs for latest billing + last-active) replaces the two-tier fan-out HUB-1646 originally
// specified (tenants → per-tenant products). Sized for v0.1 portfolio scale (5–10 products);
// no Redis cache per the story's "small enough" rationale.
//
// Spec deviations (documented per ironclad-engineer rules):
// 1. MRR source: spec said "stripe_subscriptions (or equivalent)" — the actual HUB MRR proxy
//    is billing_period_costs.total_cost_cents (matches getPortfolioSummary in
//    planAdvisorService). LATERAL DISTINCT ON picks the most recent period per tenant.
// 2. lastActiveAt: spec didn't pin the column; MAX(stripe_subscriptions.updated_at) per
//    product is the most recent subscription event (status flip, period roll, cancel).
//    null when no subscription exists.

import { getPool } from '../db/pool.js';

export interface PortfolioProduct {
  productId: string;
  productName: string;
  tenantId: string;
  tenantName: string;
  status: string;
  mrrCents: number;
  createdAt: string;
  lastActiveAt: string | null;
}

export interface GetPortfolioProductsOpts {
  operatorTenantId?: string | null; // null/undefined = super_admin (no scope filter)
  search?: string;
  limit?: number;
  offset?: number;
}

export interface GetPortfolioProductsResult {
  data: PortfolioProduct[];
  total: number;
}

export async function getPortfolioProducts(
  opts: GetPortfolioProductsOpts,
): Promise<GetPortfolioProductsResult> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 100, 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.operatorTenantId) {
    conditions.push(`p.tenant_id = $${idx++}`);
    params.push(opts.operatorTenantId);
  }
  if (opts.search) {
    conditions.push(`p.name ILIKE $${idx++}`);
    params.push(`%${opts.search}%`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // CTEs:
  //   latest_billing — latest billing_period_costs row per (product_id, tenant_id)
  //   product_mrr    — SUM(latest_billing.total_cost_cents) per product across tenants
  //   product_last_active — MAX(stripe_subscriptions.updated_at) per product
  const cteBlock = `
    WITH latest_billing AS (
      SELECT DISTINCT ON (product_id, tenant_id)
             product_id, tenant_id, total_cost_cents
        FROM billing_period_costs
       ORDER BY product_id, tenant_id, period_start DESC
    ),
    product_mrr AS (
      SELECT product_id, COALESCE(SUM(total_cost_cents), 0)::bigint AS mrr_cents
        FROM latest_billing
       GROUP BY product_id
    ),
    product_last_active AS (
      SELECT product_id, MAX(updated_at) AS last_active_at
        FROM stripe_subscriptions
       GROUP BY product_id
    )
  `;

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::bigint AS count
       FROM products p
       JOIN tenants t ON t.id = p.tenant_id
       ${where}`,
    params,
  );
  const total = parseInt(countRows[0]!.count, 10);

  const { rows } = await pool.query<{
    product_id: string;
    product_name: string;
    tenant_id: string;
    tenant_name: string;
    status: string;
    mrr_cents: string | null;
    created_at: Date;
    last_active_at: Date | null;
  }>(
    `${cteBlock}
     SELECT p.id AS product_id,
            p.name AS product_name,
            p.tenant_id, t.name AS tenant_name,
            p.status,
            COALESCE(pm.mrr_cents, 0)::bigint AS mrr_cents,
            p.created_at,
            pla.last_active_at
       FROM products p
       JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN product_mrr pm ON pm.product_id = p.id
       LEFT JOIN product_last_active pla ON pla.product_id = p.id
       ${where}
   ORDER BY p.name ASC
      LIMIT $${idx++} OFFSET $${idx}`,
    [...params, limit, offset],
  );

  return {
    total,
    data: rows.map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      status: r.status,
      mrrCents: parseInt(r.mrr_cents ?? '0', 10),
      createdAt: r.created_at.toISOString(),
      lastActiveAt: r.last_active_at ? r.last_active_at.toISOString() : null,
    })),
  };
}
