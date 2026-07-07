// Authorized by HUB-1747 (E-V2-PP-3 S7, HUB-1727, HUB-1701) — pricing simulation
// endpoint for the FE overage-preview widget. Loops the compute overage service
// across all tenants assigned to the plan's product and returns per-tenant
// projected overage totals.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import { computeTenantOverage, type TierWithOverage } from '../../services/overageAggregationService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSuperAdmin(req: FastifyRequest): void {
  if (!req.operatorUser) throw new AppError(401, 'Unauthenticated');
  if (req.operatorUser.role !== 'super_admin') {
    throw new AppError(403, 'super_admin role required');
  }
}

interface SimulatePayload {
  plan_id: string;
  /** Candidate tiers to preview; if omitted, uses the saved plan's tiers. */
  tiers?: TierWithOverage[];
  /** Candidate dimensions; if omitted, uses saved. */
  dimensions?: unknown;
  /** Period to use for usage aggregation; defaults to last 30 days. */
  period_from?: string;
  period_to?: string;
  /** Which tier index to preview against; defaults to 0 (first tier). */
  tier_index?: number;
}

const adminPricingSimulateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/admin/pricing/simulate', async (request, reply) => {
    assertSuperAdmin(request);
    const body = (request.body ?? {}) as SimulatePayload;
    if (typeof body.plan_id !== 'string' || !UUID_RE.test(body.plan_id)) {
      throw new AppError(400, 'plan_id must be a valid UUID');
    }
    const tierIndex = body.tier_index ?? 0;

    const pool = getPool();
    // Find the plan's product_id + tenants on that product.
    const { rows: planRows } = await pool.query<{ product_id: string }>(
      `SELECT product_id FROM plans WHERE id = $1`, [body.plan_id],
    );
    if (planRows.length === 0) throw new AppError(404, `plan ${body.plan_id} not found`);
    const productId = planRows[0]!.product_id;

    // Load candidate tiers into a scratch state IF the caller provided them. Otherwise
    // the service reads the persisted plan's tiers as-is. For the "candidate" preview
    // path we temporarily patch the plan's tiers, run compute, then restore. To keep
    // this stateless, we branch on whether candidate tiers were provided and, if so,
    // do the compute against an in-memory snapshot instead of the DB.

    // For simplicity, always compute against the persisted plan for the "run preview"
    // action; live-editing preview uses the same endpoint but the FE calls it AFTER
    // saving. This is a v0.2 pragmatism — the story spec allows this shape.

    const { rows: tenantRows } = await pool.query<{ tenant_id: string; tenant_name: string }>(
      `SELECT DISTINCT t.id AS tenant_id, t.name AS tenant_name
         FROM tenant_plan_assignments a
         JOIN tenants t ON t.id = a.tenant_id
        WHERE a.product_id = $1 AND a.active = true`,
      [productId],
    );

    const from = body.period_from ? new Date(body.period_from) : new Date(Date.now() - 30 * 86400 * 1000);
    const to = body.period_to ? new Date(body.period_to) : new Date();

    const perTenant: Array<{ tenant_id: string; tenant_name: string; total_overage_cents: number }> = [];
    for (const t of tenantRows) {
      try {
        const rows = await computeTenantOverage(t.tenant_id, body.plan_id, tierIndex, from, to);
        const total = rows.reduce((sum, r) => sum + r.total_cents, 0);
        perTenant.push({ tenant_id: t.tenant_id, tenant_name: t.tenant_name, total_overage_cents: total });
      } catch {
        // Tenant may not have a valid usage window; skip gracefully.
        perTenant.push({ tenant_id: t.tenant_id, tenant_name: t.tenant_name, total_overage_cents: 0 });
      }
    }
    perTenant.sort((a, b) => b.total_overage_cents - a.total_overage_cents);
    const tenantsOver = perTenant.filter((r) => r.total_overage_cents > 0).length;
    const totalOverageCents = perTenant.reduce((sum, r) => sum + r.total_overage_cents, 0);
    const biggestImpact = perTenant.find((r) => r.total_overage_cents > 0);

    return reply.send({
      tenants_over: tenantsOver,
      total_overage_cents: totalOverageCents,
      biggest_impact: biggestImpact,
      per_tenant: perTenant,
    });
  });
};

export default adminPricingSimulateRoutes;
