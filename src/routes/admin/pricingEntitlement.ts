// Authorized by HUB-1866 (S1 of HUB-1865) — tenant entitlement endpoint.
//
// GET /api/v1/admin/pricing/tenant/:tenantId/entitlement
//
// Returns the EntitlementStatus shape that LaunchKit's HubResolver
// (@launchkit/components v0.1+, authored under LK-5031) consumes. Powers
// LaunchKit's EntitlementGate component so LK-substrate apps can gate access
// on real HUB billing state instead of always rendering the fallback.
//
// Contract shape:
//   {
//     tenantId, planId, subscriptionValid, billingCurrent,
//     entitlements[], gatingFlags: { reason?, expiresAt? }, asOf
//   }
//
// Derivation:
//   * subscriptionValid = row exists AND status ∈ {active, trialing}
//   * billingCurrent    = row exists AND status NOT IN {past_due, unpaid, canceled}
//   * planId            = plans.id resolved via stripe_subscriptions.stripe_price_id
//                         (LEFT JOIN because a subscription might reference a
//                         Stripe price that wasn't imported into plans yet).
//   * gatingFlags.reason:
//       - 'no-subscription'  when the tenant has no stripe_subscriptions row
//       - 'past-due'         when status = past_due or unpaid
//       - 'canceled'         when status = canceled or unpaid_terminal
//       - omitted            when subscriptionValid && billingCurrent
//   * entitlements[]    = [] for v1. Plan.entitlements JSONB extraction is a
//                         separate follow-up story so this endpoint ships
//                         with a stable contract that consumers can rely on
//                         without waiting for the entitlement-derivation work.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';

interface OperatorAuth {
  role?: string;
  tenant_id?: string | null;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  return (req as unknown as { operatorUser?: OperatorAuth }).operatorUser ?? {};
}

interface EntitlementRow {
  tenant_exists: boolean;
  sub_status: string | null;
  plan_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
}

interface EntitlementStatus {
  tenantId: string;
  planId: string | null;
  subscriptionValid: boolean;
  billingCurrent: boolean;
  entitlements: string[];
  gatingFlags: { reason?: string; expiresAt?: string | null };
  asOf: string;
}

const VALID_STATUSES = new Set(['active', 'trialing']);
const NOT_BILLING_CURRENT = new Set(['past_due', 'unpaid']);
const CANCELED_STATUSES = new Set(['canceled', 'incomplete_expired']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function computeStatus(row: EntitlementRow, tenantId: string): EntitlementStatus {
  const asOf = new Date().toISOString();
  const subStatus = row.sub_status;
  const hasSubscription = subStatus !== null;
  const subscriptionValid = hasSubscription && VALID_STATUSES.has(subStatus);
  const billingCurrent =
    hasSubscription &&
    !NOT_BILLING_CURRENT.has(subStatus) &&
    !CANCELED_STATUSES.has(subStatus);

  let reason: string | undefined;
  if (!hasSubscription) reason = 'no-subscription';
  else if (NOT_BILLING_CURRENT.has(subStatus)) reason = 'past-due';
  else if (CANCELED_STATUSES.has(subStatus)) reason = 'canceled';

  return {
    tenantId,
    planId: row.plan_id,
    subscriptionValid,
    billingCurrent,
    entitlements: [],
    gatingFlags: {
      ...(reason ? { reason } : {}),
      expiresAt: row.current_period_end ?? null,
    },
    asOf,
  };
}

const adminPricingEntitlementRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { tenantId: string } }>(
    '/api/v1/admin/pricing/tenant/:tenantId/entitlement',
    async (req) => {
      const op = operatorFromRequest(req);
      if (op.role !== 'super_admin' && op.role !== 'product_admin') {
        throw new AppError(403, 'Entitlement read requires super_admin or product_admin');
      }
      const tenantId = req.params.tenantId;
      if (!UUID_RE.test(tenantId)) {
        throw new AppError(400, 'tenantId must be a valid UUID');
      }

      const pool = getPool();
      // Single query: verifies tenant exists AND left-joins any subscription.
      // If the tenant doesn't exist at all → empty result → 404.
      // If the tenant exists but has no subscription → row with sub_status=null.
      const { rows } = await pool.query<EntitlementRow>(
        `SELECT
           TRUE                                         AS tenant_exists,
           s.status                                     AS sub_status,
           p.id::text                                   AS plan_id,
           s.current_period_end::text                   AS current_period_end,
           s.cancel_at_period_end                       AS cancel_at_period_end
         FROM tenants t
         LEFT JOIN stripe_subscriptions s ON s.tenant_id = t.id
         LEFT JOIN plans p ON p.stripe_price_id = s.stripe_price_id
         WHERE t.id = $1::uuid
         ORDER BY s.current_period_end DESC NULLS LAST
         LIMIT 1`,
        [tenantId],
      );

      if (rows.length === 0) {
        throw new AppError(404, `Unknown tenant '${tenantId}'`);
      }

      return computeStatus(rows[0]!, tenantId);
    },
  );
};

export default adminPricingEntitlementRoutes;
