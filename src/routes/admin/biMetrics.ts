// Authorized by HUB-1805 (S3 of HUB-1785) — POST /api/v1/admin/bi/metrics.
// Batched ingestion endpoint. Accepts { events: MetricEventInput[] } and returns
// { accepted, dropped: [{ index, reason }] }. Malformed events, unknown metric names,
// value type mismatches, stale timestamps, and unknown product_ids are all DROPPED
// (never fail the batch) — the response tells the caller exactly what went wrong per
// event so an app can retry a corrected payload without losing the accepted rows.
//
// RBAC: super_admin operator (via the admin scope RBAC hook) OR a service-token
// header 'X-HUB-Service-Token' matching HUB_SERVICE_TOKEN env var. The service token
// is a placeholder until the onboarding Epic ships per-app JWTs.
//
// Audit trail: one audit_log entry per batch summarizing accepted + dropped counts.
// Additionally, every 'unknown_metric' drop writes its own audit entry so we notice
// when the catalog is drifting.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import { writeAuditEntry } from '../../services/auditLogService.js';
import { ingestMetricBatch, type IngestDropReason } from '../../services/bi/metricIngestService.js';

const AUDIT_TENANT_ID = 'system';
const AUDIT_TABLE = 'metric_events';

interface OperatorAuth {
  operator_id?: string;
  role?: string;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  return (req as unknown as { operatorUser?: OperatorAuth }).operatorUser ?? {};
}

function hasServiceToken(req: FastifyRequest): boolean {
  const supplied = req.headers['x-hub-service-token'];
  const expected = process.env['HUB_SERVICE_TOKEN'];
  if (!expected) return false;
  if (typeof supplied !== 'string') return false;
  return supplied === expected;
}

async function defaultProductExistenceCheck(productIds: string[]): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id::text FROM products WHERE id = ANY($1::uuid[])`,
    [productIds],
  );
  return new Set(rows.map((r) => r.id));
}

interface IngestBody {
  events: unknown[];
}

const adminBiMetricsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: IngestBody }>('/api/v1/admin/bi/metrics', async (req, reply) => {
    const op = operatorFromRequest(req);
    if (op.role !== 'super_admin' && !hasServiceToken(req)) {
      throw new AppError(403, 'Ingestion requires super_admin operator or a valid service token');
    }
    const body = (req.body ?? {}) as Partial<IngestBody>;
    if (!Array.isArray(body.events)) {
      throw new AppError(400, 'events (array) is required');
    }
    if (body.events.length === 0) {
      return reply.status(200).send({ accepted: 0, dropped: [] });
    }
    if (body.events.length > 1000) {
      throw new AppError(400, 'batch size must be <= 1000 events');
    }

    const injectedCheck = (fastify as unknown as {
      productExistenceCheck?: (ids: string[]) => Promise<Set<string>>;
    }).productExistenceCheck;

    const result = await ingestMetricBatch({
      events: body.events,
      productExistenceCheck: injectedCheck ?? defaultProductExistenceCheck,
    });

    // Batch summary audit.
    await writeAuditEntry({
      tenant_id: AUDIT_TENANT_ID,
      actor_id: op.operator_id ?? null,
      actor_type: op.operator_id ? 'operator' : 'service',
      operation: 'INSERT',
      table_name: AUDIT_TABLE,
      new_values: {
        action: 'bi.metric.ingest',
        accepted: result.accepted,
        dropped_count: result.dropped.length,
      },
    });

    // Per-unknown-metric audit rows so we're forced to notice catalog drift.
    const unknownMetrics = result.dropped.filter(
      (d: IngestDropReason) => d.category === 'unknown_metric',
    );
    for (const d of unknownMetrics) {
      await writeAuditEntry({
        tenant_id: AUDIT_TENANT_ID,
        actor_id: op.operator_id ?? null,
        actor_type: op.operator_id ? 'operator' : 'service',
        operation: 'INSERT',
        table_name: AUDIT_TABLE,
        new_values: {
          action: 'bi.metric.unknown_metric',
          metric_name: d.metric_name,
        },
      });
    }

    return reply.status(200).send(result);
  });
};

export default adminBiMetricsRoutes;
