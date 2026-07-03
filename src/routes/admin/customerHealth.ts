// Authorized by HUB-1680 (E-FE-9 S1) — Customer Health BE route. Two GETs:
//
//   GET /api/v1/admin/customer-health
//     ?productId=&riskLevel=&sortBy=&limit=&offset=&fresh=
//     → per-(tenant, product) roll-up with health badge + churn score +
//       signal keys + last-active timestamp. RBAC-scoped; 5-min in-memory
//       cache keyed by (operatorId, filter params).
//
//   GET /api/v1/admin/customer-health/:tenantId?productId=
//     → drill-in bundle for a single (tenant, product): score + signals
//       array + 90-day usage timeline + last-advisor-run timestamp.
//
// RBAC (server-authoritative, defense-in-depth):
//   - super_admin: all tenants + all their products.
//   - product_admin: only tenants matching op.tenant_id (D-HUB-SCOPE-035
//     v0.1 lock — no scoped_products[] JWT claim expansion until v0.2).
//
// Spec deviations (per ironclad-engineer, HUB-1680):
//
//   1. Multi-product `scoped_products[]` RBAC: story spec described a
//      JWT `scoped_products[]` claim; v0.1 lock (D-HUB-SCOPE-035) has no
//      such claim. The tenant_id single-tenant rule stands instead. The
//      multi-product tenant question resolves cleanly under the v0.1 lock
//      (a product_admin scopes to their tenant; that tenant's own products
//      are all in-scope). v0.2 candidate: JWT claim expansion.
//
//   2. `plan_downgrade_recent` signal renamed to `plan_change_recent`:
//      plan_change_ledger has no direction column at v0.1. See
//      churnRiskSignals.ts for the full write-up.
//
//   3. MRR proxy: the story asked for a first-class `mrrCents`. At v0.1
//      we surface `mrrCents` = most recent complete billing period's
//      total_cost_cents from planAdvisorService.getBillingSummary (which
//      already computes it). Genuine subscription-price MRR (independent
//      of usage bursts) would need a per-plan monthly-price join not
//      wired to /customer-health yet — HUB-1545-style tech debt candidate.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import { getSetting } from '../../services/adminSettings.js';
import { getBillingSummary } from '../../services/planAdvisorService.js';
import {
  deriveCustomerHealth,
  deriveHealthBadge,
  getUsageTimeline90d,
  type CustomerHealthThresholds,
  type HealthBadge,
} from '../../services/customerHealthService.js';
import type { ChurnRiskSignalKey } from '../../types/churnRiskSignals.js';

const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface HealthListRow {
  tenantId: string;
  tenantName: string;
  productId: string;
  productName: string;
  planKey: string | null;
  mrrCents: number | null;
  healthBadge: HealthBadge;
  churnRiskScore: number;
  lastActiveAt: string | null;
  signals: ChurnRiskSignalKey[];
}

interface HealthListPayload {
  rows: HealthListRow[];
  total: number;
  generatedAt: string;
  meta: { thresholds: CustomerHealthThresholds };
}

interface HealthListCacheEntry {
  key: string;
  computedAt: number;
  payload: HealthListPayload;
}

let listCache: HealthListCacheEntry | null = null;

export function _resetCustomerHealthCache(): void {
  listCache = null;
}

async function assertOperator(request: FastifyRequest): Promise<void> {
  if (!request.operatorUser) throw new AppError(401, 'Unauthenticated');
}

function isFreshRequested(request: FastifyRequest): boolean {
  const q = request.query as Record<string, string | undefined>;
  return q.fresh === 'true' || q.fresh === '1';
}

async function readThresholds(): Promise<CustomerHealthThresholds> {
  const [red, yellow, stale] = await Promise.all([
    getSetting('customer_health_red_threshold'),
    getSetting('customer_health_yellow_threshold'),
    getSetting('customer_health_stale_days'),
  ]);
  return {
    red: typeof red === 'number' ? red : 0.7,
    yellow: typeof yellow === 'number' ? yellow : 0.4,
    staleDays: typeof stale === 'number' ? stale : 14,
  };
}

async function fetchInScopeTenantProducts(
  request: FastifyRequest,
  productFilter: string | null,
): Promise<Array<{ tenant_id: string; tenant_name: string; product_id: string; product_name: string }>> {
  const op = request.operatorUser!;
  const pool = getPool();
  const conditions: string[] = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];
  let idx = 1;
  if (op.role === 'product_admin') {
    conditions.push(`t.id = $${idx++}`);
    params.push(op.tenant_id);
  }
  if (productFilter) {
    conditions.push(`p.id = $${idx++}`);
    params.push(productFilter);
  }
  const { rows } = await pool.query<{
    tenant_id: string;
    tenant_name: string;
    product_id: string;
    product_name: string;
  }>(
    `SELECT t.id AS tenant_id, t.name AS tenant_name,
            p.id AS product_id, p.name AS product_name
       FROM tenants t
       JOIN products p ON p.tenant_id = t.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.name ASC, p.name ASC`,
    params,
  );
  return rows;
}

async function computeMrrAndPlan(
  tenantId: string,
  productId: string,
): Promise<{ planKey: string | null; mrrCents: number | null }> {
  const pool = getPool();

  // Last plan_change_ledger row is the current plan (v0.1 proxy).
  const { rows: planRows } = await pool.query<{ plan_id: string }>(
    `SELECT plan_id
       FROM plan_change_ledger
      WHERE tenant_id = $1 AND product_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, productId],
  );
  const planKey = planRows[0]?.plan_id ?? null;

  // MRR proxy = most recent complete billing period's total_cost_cents.
  const periods = await getBillingSummary(productId, tenantId);
  const mrrCents = periods[0]?.total_cost_cents ?? null;

  return { planKey, mrrCents };
}

const RISK_LEVELS = new Set(['high', 'medium', 'low']);

function matchesRiskLevel(row: HealthListRow, filter: Set<string>): boolean {
  if (filter.size === 0) return true;
  const badgeToLevel: Record<HealthBadge, string> = {
    red: 'high',
    yellow: 'medium',
    green: 'low',
  };
  return filter.has(badgeToLevel[row.healthBadge]);
}

async function computeHealthList(
  request: FastifyRequest,
  productFilter: string | null,
  riskLevels: Set<string>,
  sortBy: 'risk' | 'mrr' | 'name',
): Promise<HealthListPayload> {
  const thresholds = await readThresholds();
  const pairs = await fetchInScopeTenantProducts(request, productFilter);

  const rows = await Promise.all(
    pairs.map(async (pair): Promise<HealthListRow> => {
      const health = await deriveCustomerHealth(pair.tenant_id, pair.product_id);
      const badge = deriveHealthBadge(
        health.score,
        health.lastActiveAt,
        thresholds,
      );
      const { planKey, mrrCents } = await computeMrrAndPlan(
        pair.tenant_id,
        pair.product_id,
      );
      return {
        tenantId: pair.tenant_id,
        tenantName: pair.tenant_name,
        productId: pair.product_id,
        productName: pair.product_name,
        planKey,
        mrrCents,
        healthBadge: badge,
        churnRiskScore: health.score,
        lastActiveAt: health.lastActiveAt,
        signals: health.signals.map((s) => s.key),
      };
    }),
  );

  const filtered = rows.filter((r) => matchesRiskLevel(r, riskLevels));

  filtered.sort((a, b) => {
    if (sortBy === 'mrr') return (b.mrrCents ?? 0) - (a.mrrCents ?? 0);
    if (sortBy === 'name') return a.tenantName.localeCompare(b.tenantName);
    // 'risk' default: score DESC, then tenant name ASC as a stable tiebreaker.
    if (b.churnRiskScore !== a.churnRiskScore)
      return b.churnRiskScore - a.churnRiskScore;
    return a.tenantName.localeCompare(b.tenantName);
  });

  return {
    rows: filtered,
    total: filtered.length,
    generatedAt: new Date().toISOString(),
    meta: { thresholds },
  };
}

function cacheKeyFor(
  request: FastifyRequest,
  productFilter: string | null,
  riskLevels: string[],
  sortBy: string,
): string {
  const op = request.operatorUser!;
  const scope = op.role === 'super_admin' ? 'all' : `t:${op.tenant_id ?? 'none'}`;
  return `${scope}|p:${productFilter ?? '*'}|r:${riskLevels.slice().sort().join(',')}|s:${sortBy}`;
}

const adminCustomerHealthRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Aggregated list ───────────────────────────────────────────────────
  fastify.get('/api/v1/admin/customer-health', async (request, reply) => {
    await assertOperator(request);
    const q = request.query as Record<string, string | undefined>;
    const productFilter = q.productId ?? null;
    const riskLevels = new Set(
      (q.riskLevel ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => RISK_LEVELS.has(s)),
    );
    const sortByRaw = (q.sortBy ?? 'risk').toLowerCase();
    const sortBy: 'risk' | 'mrr' | 'name' =
      sortByRaw === 'mrr' ? 'mrr' : sortByRaw === 'name' ? 'name' : 'risk';
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(q.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
    );
    const offset = Math.max(0, parseInt(q.offset ?? '0', 10) || 0);

    const key = cacheKeyFor(
      request,
      productFilter,
      Array.from(riskLevels),
      sortBy,
    );

    let payload: HealthListPayload;
    const now = Date.now();
    if (
      !isFreshRequested(request) &&
      listCache &&
      listCache.key === key &&
      now - listCache.computedAt < HEALTH_CACHE_TTL_MS
    ) {
      payload = listCache.payload;
    } else {
      payload = await computeHealthList(request, productFilter, riskLevels, sortBy);
      listCache = { key, computedAt: now, payload };
    }

    // Paginate over the cached full list.
    const sliced = payload.rows.slice(offset, offset + limit);
    return reply.send({
      rows: sliced,
      total: payload.total,
      generatedAt: payload.generatedAt,
      meta: payload.meta,
    });
  });

  // ── Drill-in ──────────────────────────────────────────────────────────
  fastify.get(
    '/api/v1/admin/customer-health/:tenantId',
    async (request, reply) => {
      await assertOperator(request);
      const op = request.operatorUser!;
      const params = request.params as { tenantId: string };
      const q = request.query as Record<string, string | undefined>;
      const tenantId = params.tenantId;
      const productId = q.productId;
      if (!productId) throw new AppError(400, 'productId is required');

      // RBAC + ownership: verify the (tenant, product) pair is in scope.
      const pool = getPool();
      const { rows: pairRows } = await pool.query<{ tenant_name: string; product_name: string }>(
        `SELECT t.name AS tenant_name, p.name AS product_name
           FROM tenants t
           JOIN products p ON p.tenant_id = t.id
          WHERE t.id = $1 AND p.id = $2 AND t.deleted_at IS NULL`,
        [tenantId, productId],
      );
      if (pairRows.length === 0) throw new AppError(404, 'Tenant + product pair not found');
      if (op.role === 'product_admin' && tenantId !== op.tenant_id) {
        throw new AppError(403, 'Tenant out of scope');
      }
      const pair = pairRows[0]!;

      const thresholds = await readThresholds();
      const [health, { planKey, mrrCents }, usageTimeline90d] = await Promise.all([
        deriveCustomerHealth(tenantId, productId),
        computeMrrAndPlan(tenantId, productId),
        getUsageTimeline90d(tenantId, productId),
      ]);
      const badge = deriveHealthBadge(health.score, health.lastActiveAt, thresholds);

      return reply.send({
        tenant: { id: tenantId, name: pair.tenant_name },
        product: { id: productId, name: pair.product_name },
        currentPlan: { key: planKey },
        mrr: { cents: mrrCents, currency: 'USD' },
        healthBadge: badge,
        churnRiskScore: health.score,
        lastActiveAt: health.lastActiveAt,
        lastAdvisorRunAt: health.lastAdvisorRunAt,
        signals: health.signals,
        usageTimeline90d,
        meta: { thresholds },
      });
    },
  );
};

export default adminCustomerHealthRoutes;
