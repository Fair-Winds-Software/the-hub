// Authorized by HUB-1820 (S3 of HUB-1787) — POST /api/v1/bi/metrics for SDK-driven
// ingestion. Business-scoped (not admin): authenticated via the existing HUB-98 OAuth2
// JWT plugin (fastify.authenticate) so registered apps can push their own metrics using
// the client_id/client_secret they got from the S1 onboarding flow.
//
// Defense-in-depth: the JWT payload carries the product_id issued at token time. This
// endpoint FORCIBLY OVERWRITES event.product_id with req.product_id — a malicious client
// cannot push metrics attributed to a different product.
//
// Delegates the actual persistence to the shared ingestMetricBatch() service (HUB-1805 /
// S3 of HUB-1785). Same drop-categories, same audit trail, same rate-limits.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../errors/AppError.js';
import { getPool } from '../db/pool.js';
import { ingestMetricBatch } from '../services/bi/metricIngestService.js';
import { writeAuditEntry } from '../services/auditLogService.js';

const AUDIT_TENANT_SENTINEL = 'system';

interface IngestBody {
  events: Array<Record<string, unknown>>;
}

async function productExistenceCheck(productIds: string[]): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id::text FROM products WHERE id = ANY($1::uuid[])`,
    [productIds],
  );
  return new Set(rows.map((r) => r.id));
}

const biMetricsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: IngestBody }>(
    '/api/v1/bi/metrics',
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const jwtProductId = (req as unknown as { product_id: string }).product_id;
      const jwtTenantId = (req as unknown as { tenant_id: string }).tenant_id;

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

      // Force product_id on every event — defense-in-depth against a client trying to
      // attribute a push to someone else's product. The service still validates that
      // the product_id resolves against the products table (which it will, since it
      // came from a valid JWT), but we belt-and-suspender it.
      const scopedEvents = body.events.map((raw) => ({
        ...(raw as Record<string, unknown>),
        product_id: jwtProductId,
      }));

      const injectedCheck = (fastify as unknown as {
        productExistenceCheck?: (ids: string[]) => Promise<Set<string>>;
      }).productExistenceCheck;

      const result = await ingestMetricBatch({
        events: scopedEvents,
        productExistenceCheck: injectedCheck ?? productExistenceCheck,
      });

      await writeAuditEntry({
        tenant_id: jwtTenantId ?? AUDIT_TENANT_SENTINEL,
        product_id: jwtProductId,
        actor_type: 'service',
        operation: 'INSERT',
        table_name: 'metric_events',
        new_values: {
          action: 'bi.metric.ingest.sdk',
          accepted: result.accepted,
          dropped_count: result.dropped.length,
        },
      });

      return reply.status(200).send(result);
    },
  );
};

export default biMetricsRoutes;
