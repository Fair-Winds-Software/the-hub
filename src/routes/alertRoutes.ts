// Authorized by HUB-725 — POST acknowledge/resolve, GET paginated list; operator JWT; alert_events
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

const VALID_STATUSES   = new Set(['new', 'acknowledged', 'resolved']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

const alertRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /api/v1/alerts/:tenantId/:alertId/acknowledge ────────────────────
  fastify.post(
    '/api/v1/alerts/:tenantId/:alertId/acknowledge',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, alertId } = request.params as { tenantId: string; alertId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(alertId, 'alertId');

      const pool = getPool();
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM alert_events WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [alertId, tenantId],
        );
        if (rows.length === 0) throw new AppError(404, 'Alert not found');

        const current = rows[0]!.status;
        if (current === 'acknowledged') throw new AppError(400, 'Alert is already acknowledged');
        if (current === 'resolved')     throw new AppError(400, 'Cannot acknowledge a resolved alert');

        const { rows: updated } = await client.query(
          `UPDATE alert_events SET status = 'acknowledged', acknowledged_at = NOW() WHERE id = $1 RETURNING *`,
          [alertId],
        );
        return reply.status(200).send(updated[0]);
      } finally {
        client.release();
      }
    },
  );

  // ── POST /api/v1/alerts/:tenantId/:alertId/resolve ────────────────────────
  fastify.post(
    '/api/v1/alerts/:tenantId/:alertId/resolve',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, alertId } = request.params as { tenantId: string; alertId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(alertId, 'alertId');

      const pool = getPool();
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM alert_events WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [alertId, tenantId],
        );
        if (rows.length === 0) throw new AppError(404, 'Alert not found');
        if (rows[0]!.status === 'resolved') throw new AppError(400, 'Alert is already resolved');

        const { rows: updated } = await client.query(
          `UPDATE alert_events SET status = 'resolved', resolved_at = NOW() WHERE id = $1 RETURNING *`,
          [alertId],
        );
        return reply.status(200).send(updated[0]);
      } finally {
        client.release();
      }
    },
  );

  // ── GET /api/v1/alerts/:tenantId ──────────────────────────────────────────
  fastify.get(
    '/api/v1/alerts/:tenantId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      assertUUID(tenantId, 'tenantId');

      const query = request.query as Record<string, string | undefined>;
      const { status, severity } = query;
      const limit  = Math.min(parseInt(query.limit  ?? '20', 10), 100);
      const offset = parseInt(query.offset ?? '0', 10);

      if (status   && !VALID_STATUSES.has(status))     throw new AppError(400, `Invalid status: ${status}`);
      if (severity && !VALID_SEVERITIES.has(severity)) throw new AppError(400, `Invalid severity: ${severity}`);

      const params: unknown[] = [tenantId];
      let where = 'WHERE tenant_id = $1';

      if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
      }
      if (severity) {
        params.push(severity);
        where += ` AND severity = $${params.length}`;
      }

      const pool = getPool();
      const [{ rows: alerts }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT * FROM alert_events ${where} ORDER BY first_fired_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM alert_events ${where}`,
          params,
        ),
      ]);

      return reply.status(200).send({
        alerts,
        total: parseInt(countRows[0]!.count, 10),
        limit,
        offset,
      });
    },
  );
};

export default fp(alertRoutes, { name: 'alert-routes' });
