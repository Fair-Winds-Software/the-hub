// Authorized by HUB-1674 (E-FE-7 S1) — system health BE routes. Four new
// admin GET endpoints consumed by HUB-1566 (E-FE-7) FE stories:
//
//   GET /api/v1/admin/system-health/portfolio          → per-product roll-up
//   GET /api/v1/admin/system-health/queues             → BullMQ depth + DLQ + oldest waiting
//   GET /api/v1/admin/system-health/stripe-webhooks    → success/failure rate over window
//   GET /api/v1/admin/system-health/audit-errors       → recent .failure audit rows
//
// RBAC (server-authoritative, defense-in-depth):
//   - super_admin gets the full portfolio + all queues + all webhooks.
//   - product_admin gets a tenant-scoped portfolio (products.tenant_id =
//     op.tenant_id) and is rejected 403 on audit-errors when the
//     productId query param does not belong to that tenant.
//
// Cache-bypass contract:
//
//   /portfolio accepts ?fresh=true which bypasses the 30s in-memory cache
//   (recomputes from source + refreshes the cache entry). The FE Refresh
//   controls in Queues + Webhooks tabs already pass this param; portfolio
//   now honours it too.
//
// Remaining spec deviation (documented per ironclad-engineer):
//
//   Server-side 30s cache: the portfolio aggregator uses an in-memory
//   Map with a TTL. In a multi-instance deployment the cache is per-
//   instance (not shared). Acceptable at v0.1 (single-instance HUB);
//   HUB-1545 tech debt candidate: move to Redis if we scale out.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import { getSetting } from '../../services/adminSettings.js';
import { getAllQueueDefinitions } from '../../queues/index.js';
import {
  getOrExecuteProbe,
  type ProbeInput,
} from '../../services/productHealthProbe.js';

const PORTFOLIO_CACHE_TTL_MS = 30_000;

interface PortfolioRow {
  productId: string;
  reachable: boolean;
  lastProbedAt: string;
  errorRate24h: number;
  lastErrorEvent: { timestamp: string; message: string } | null;
}

interface PortfolioCacheEntry {
  key: string;
  computedAt: number;
  payload: {
    products: PortfolioRow[];
    generatedAt: string;
    meta: { threshold: number };
  };
}

let portfolioCache: PortfolioCacheEntry | null = null;

function isSuperAdmin(request: FastifyRequest): boolean {
  return request.operatorUser?.role === 'super_admin';
}

async function assertOperator(request: FastifyRequest): Promise<void> {
  if (!request.operatorUser) throw new AppError(401, 'Unauthenticated');
}

async function readErrorRateThreshold(): Promise<number> {
  const raw = await getSetting('system_health_error_rate_threshold');
  if (typeof raw === 'number') return raw;
  return 0.05;
}

async function computePortfolio(
  operatorTenantId: string | null,
): Promise<PortfolioCacheEntry['payload']> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (operatorTenantId !== null) {
    conditions.push(`p.tenant_id = $${idx++}`);
    params.push(operatorTenantId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: products } = await pool.query<{
    product_id: string;
    active: boolean;
    health_check_url: string | null;
    last_probe_at: Date | null;
    last_probe_reachable: boolean | null;
    last_probe_error: string | null;
    last_probe_latency_ms: number | null;
  }>(
    `SELECT p.id AS product_id, p.active,
            p.health_check_url, p.last_probe_at, p.last_probe_reachable,
            p.last_probe_error, p.last_probe_latency_ms
       FROM products p
       ${where}
      ORDER BY p.created_at ASC`,
    params,
  );

  if (products.length === 0) {
    const threshold = await readErrorRateThreshold();
    return {
      products: [],
      generatedAt: new Date().toISOString(),
      meta: { threshold },
    };
  }

  // 24-hour error rate + last error per product, joined once.
  const productIds = products.map((p) => p.product_id);
  const { rows: errStats } = await pool.query<{
    product_id: string;
    total_count: string;
    failure_count: string;
    last_failure_at: Date | null;
    last_failure_new_values: Record<string, unknown> | null;
  }>(
    `SELECT product_id,
            COUNT(*)::TEXT AS total_count,
            COUNT(*) FILTER (WHERE severity = 'error')::TEXT AS failure_count,
            MAX(occurred_at) FILTER (WHERE severity = 'error') AS last_failure_at,
            (ARRAY_AGG(new_values ORDER BY occurred_at DESC)
               FILTER (WHERE severity = 'error'))[1] AS last_failure_new_values
       FROM audit_log
      WHERE product_id = ANY($1::uuid[])
        AND occurred_at >= NOW() - INTERVAL '24 hours'
      GROUP BY product_id`,
    [productIds],
  );

  const errIndex = new Map<
    string,
    {
      total: number;
      failure: number;
      lastAt: Date | null;
      lastMessage: string | null;
    }
  >();
  for (const r of errStats) {
    const total = parseInt(r.total_count, 10);
    const failure = parseInt(r.failure_count, 10);
    const message =
      (r.last_failure_new_values as { message?: string } | null)?.message ??
      null;
    errIndex.set(r.product_id, {
      total,
      failure,
      lastAt: r.last_failure_at,
      lastMessage: message,
    });
  }

  const now = new Date().toISOString();
  const portfolioRows: PortfolioRow[] = await Promise.all(
    products.map(async (p): Promise<PortfolioRow> => {
      const stats = errIndex.get(p.product_id);
      const total = stats?.total ?? 0;
      const failure = stats?.failure ?? 0;
      const errorRate24h = total > 0 ? failure / total : 0;

      // Per-product reachability: when health_check_url is configured, use
      // the on-demand probe (60s TTL). Otherwise fall back to
      // products.active as the legacy proxy.
      let reachable = p.active;
      let lastProbedAt = now;
      if (p.health_check_url) {
        const probeInput: ProbeInput = {
          product_id: p.product_id,
          health_check_url: p.health_check_url,
          last_probe_at: p.last_probe_at,
          last_probe_reachable: p.last_probe_reachable,
          last_probe_error: p.last_probe_error,
          last_probe_latency_ms: p.last_probe_latency_ms,
        };
        const probe = await getOrExecuteProbe(probeInput);
        reachable = probe.reachable;
        lastProbedAt = probe.probedAt.toISOString();
      }

      return {
        productId: p.product_id,
        reachable,
        lastProbedAt,
        errorRate24h,
        lastErrorEvent:
          stats?.lastAt && stats.lastMessage
            ? {
                timestamp: stats.lastAt.toISOString(),
                message: stats.lastMessage,
              }
            : null,
      };
    }),
  );

  const threshold = await readErrorRateThreshold();
  return {
    products: portfolioRows,
    generatedAt: now,
    meta: { threshold },
  };
}

async function getPortfolioPayload(
  request: FastifyRequest,
  fresh: boolean,
): Promise<PortfolioCacheEntry['payload']> {
  const op = request.operatorUser!;
  const cacheKey = op.role === 'super_admin' ? 'all' : `t:${op.tenant_id ?? 'none'}`;
  const now = Date.now();
  if (
    !fresh &&
    portfolioCache &&
    portfolioCache.key === cacheKey &&
    now - portfolioCache.computedAt < PORTFOLIO_CACHE_TTL_MS
  ) {
    return portfolioCache.payload;
  }
  const operatorTenantId = op.role === 'super_admin' ? null : op.tenant_id;
  const payload = await computePortfolio(operatorTenantId);
  portfolioCache = { key: cacheKey, computedAt: now, payload };
  return payload;
}

function isFreshRequested(request: FastifyRequest): boolean {
  const q = request.query as Record<string, string | undefined>;
  return q.fresh === 'true' || q.fresh === '1';
}

// Exposed for tests + defense in depth — allows the integration test to
// blow the cache between assertions.
export function _resetPortfolioCache(): void {
  portfolioCache = null;
}

const adminSystemHealthRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Portfolio ──────────────────────────────────────────────────────────
  fastify.get('/api/v1/admin/system-health/portfolio', async (request, reply) => {
    await assertOperator(request);
    const payload = await getPortfolioPayload(request, isFreshRequested(request));
    return reply.send(payload);
  });

  // ── Queues ─────────────────────────────────────────────────────────────
  fastify.get('/api/v1/admin/system-health/queues', async (request, reply) => {
    await assertOperator(request);
    if (!isSuperAdmin(request)) {
      throw new AppError(403, 'super_admin required for queue visibility');
    }
    const defs = getAllQueueDefinitions();
    const queues = await Promise.all(
      defs.map(async (def) => {
        try {
          // Best-effort import — if the queue module fails (Redis down /
          // dev harness / test), we surface an empty row rather than
          // 500ing the whole endpoint.
          const mod = await import('../../queues/index.js');
          // Minimal structural type — BullMQ Queue exposes both methods,
          // but we intentionally accept a wider superset so a mocked
          // instance in tests can satisfy the shape without needing all
          // of BullMQ's Queue surface.
          interface QueueInstance {
            getJobCounts(...types: string[]): Promise<Record<string, number>>;
            getJobs(
              types: 'waiting' | 'active' | 'delayed' | 'failed' | 'completed' | 'paused',
              start: number,
              end: number,
            ): Promise<Array<{ timestamp?: number }>>;
          }
          let instance: QueueInstance | null = null;
          if (def.name === 'stripe-event')
            instance = mod.getStripeEventQueue() as unknown as QueueInstance;
          else if (def.name === 'batch-sweep')
            instance = mod.getBatchSweepQueue() as unknown as QueueInstance;
          else if (def.name === 'license-check')
            instance = mod.getLicenseCheckQueue() as unknown as QueueInstance;
          else if (def.name === 'dlq')
            instance = mod.getDlqQueue() as unknown as QueueInstance;
          const counts =
            instance !== null ? await instance.getJobCounts() : {};
          const depth =
            (counts.waiting ?? 0) +
            (counts.active ?? 0) +
            (counts.delayed ?? 0);
          const dlqSize = counts.failed ?? 0;
          let oldestJobAgeSeconds: number | null = null;
          if (instance !== null) {
            const jobs = await instance.getJobs('waiting', 0, 0);
            const oldest = jobs[0];
            if (oldest?.timestamp) {
              oldestJobAgeSeconds = Math.floor(
                (Date.now() - oldest.timestamp) / 1000,
              );
            }
          }
          return { name: def.name, depth, dlqSize, oldestJobAgeSeconds };
        } catch {
          return {
            name: def.name,
            depth: 0,
            dlqSize: 0,
            oldestJobAgeSeconds: null,
          };
        }
      }),
    );
    return reply.send({ queues, generatedAt: new Date().toISOString() });
  });

  // ── Stripe webhook health ──────────────────────────────────────────────
  fastify.get(
    '/api/v1/admin/system-health/stripe-webhooks',
    async (request, reply) => {
      await assertOperator(request);
      if (!isSuperAdmin(request)) {
        throw new AppError(403, 'super_admin required for webhook visibility');
      }
      const q = request.query as Record<string, string | undefined>;
      const windowHours = Math.max(1, Math.min(720, parseInt(q.windowHours ?? '24', 10) || 24));
      const pool = getPool();
      const { rows } = await pool.query<{
        success_count: string;
        failure_count: string;
        pending_retry_count: string;
        last_failed_at: Date | null;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('received', 'dispatched', 'processed'))::TEXT AS success_count,
           COUNT(*) FILTER (WHERE status = 'failed')::TEXT AS failure_count,
           COUNT(*) FILTER (WHERE status = 'pending_retry')::TEXT AS pending_retry_count,
           MAX(received_at) FILTER (WHERE status = 'failed') AS last_failed_at
         FROM stripe_webhook_events
         WHERE received_at >= NOW() - ($1::text || ' hours')::interval`,
        [String(windowHours)],
      );
      const row = rows[0]!;
      const successCount = parseInt(row.success_count, 10);
      const failureCount = parseInt(row.failure_count, 10);
      const pendingRetryCount = parseInt(row.pending_retry_count, 10);
      const total = successCount + failureCount;
      const successRate = total > 0 ? successCount / total : 1;
      return reply.send({
        successCount,
        failureCount,
        successRate,
        lastFailedAt: row.last_failed_at ? row.last_failed_at.toISOString() : null,
        pendingRetryCount,
        generatedAt: new Date().toISOString(),
      });
    },
  );

  // ── Audit errors (product-filtered .failure events) ────────────────────
  // HUB-1772: handler self-scopes via op.tenant_id; no URL/body/query tenant_id required.
  fastify.get(
    '/api/v1/admin/system-health/audit-errors',
    { config: { operatorSelfScoped: true } },
    async (request, reply) => {
      await assertOperator(request);
      const op = request.operatorUser!;
      const q = request.query as Record<string, string | undefined>;
      const productId = q.productId;
      const windowHours = Math.max(
        1,
        Math.min(168, parseInt(q.windowHours ?? '24', 10) || 24),
      );
      // product_admin scope check: if a productId is provided, verify
      // ownership; if none is provided, product_admin sees only their
      // own tenant's rows.
      const pool = getPool();
      let tenantFilterSql = '';
      const values: unknown[] = [String(windowHours)];
      let idx = 2;
      if (productId) {
        if (op.role === 'product_admin') {
          const { rows: ownRows } = await pool.query<{ id: string }>(
            `SELECT id FROM products WHERE id = $1 AND tenant_id = $2`,
            [productId, op.tenant_id],
          );
          if (ownRows.length === 0) {
            throw new AppError(403, 'productId out of scope');
          }
        }
        tenantFilterSql = `AND product_id = $${idx++}`;
        values.push(productId);
      } else if (op.role === 'product_admin') {
        tenantFilterSql = `AND tenant_id = $${idx++}`;
        values.push(op.tenant_id);
      }
      const { rows } = await pool.query<{
        id: string;
        tenant_id: string | null;
        product_id: string | null;
        actor_id: string | null;
        event_type: string | null;
        severity: string;
        new_values: Record<string, unknown> | null;
        occurred_at: Date;
      }>(
        `SELECT id, tenant_id, product_id, actor_id, event_type, severity, new_values, occurred_at
           FROM audit_log
          WHERE occurred_at >= NOW() - ($1::text || ' hours')::interval
            AND severity = 'error'
            ${tenantFilterSql}
          ORDER BY occurred_at DESC
          LIMIT 100`,
        values,
      );
      return reply.send({
        errors: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          productId: r.product_id,
          actorId: r.actor_id,
          eventType: r.event_type,
          severity: r.severity,
          message:
            (r.new_values as { message?: string } | null)?.message ?? null,
          occurredAt: r.occurred_at.toISOString(),
        })),
        generatedAt: new Date().toISOString(),
      });
    },
  );
};

export default adminSystemHealthRoutes;
