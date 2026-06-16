// Authorized by HUB-767 — in-app notification routes; GET paginated list + PATCH mark-read; operator JWT
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

const inAppNotificationRoutes: FastifyPluginAsync = async (fastify) => {
  // GET — paginated list with optional read filter
  fastify.get(
    '/api/v1/notifications/:tenantId/in-app',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      assertUUID(tenantId, 'tenantId');

      const query = request.query as Record<string, string | undefined>;
      const limit  = Math.min(parseInt(query.limit  ?? '20', 10), 100);
      const offset = parseInt(query.offset ?? '0', 10);

      const params: unknown[] = [tenantId];
      let readFilter = '';
      if (query.read !== undefined) {
        const readBool = query.read === 'true';
        params.push(readBool);
        readFilter = ` AND read = $${params.length}`;
      }

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT *, COUNT(*) OVER() AS total_count
         FROM in_app_notifications
         WHERE tenant_id = $1${readFilter}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );

      const total = rows.length > 0 ? parseInt((rows[0] as { total_count: string }).total_count, 10) : 0;
      const notifications = rows.map(({ total_count: _tc, ...rest }) => rest);

      return reply.status(200).send({ notifications, total, limit, offset });
    },
  );

  // PATCH — mark a single notification as read (idempotent)
  fastify.patch(
    '/api/v1/notifications/:tenantId/in-app/:notificationId/read',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, notificationId } = request.params as { tenantId: string; notificationId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(notificationId, 'notificationId');

      const pool = getPool();
      const { rows } = await pool.query<{ id: string; read: boolean }>(
        `SELECT id, read FROM in_app_notifications WHERE id = $1 AND tenant_id = $2`,
        [notificationId, tenantId],
      );

      if (rows.length === 0) throw new AppError(404, 'Notification not found');

      if (rows[0]!.read) {
        return reply.status(200).send({ id: notificationId, read: true });
      }

      await pool.query(
        `UPDATE in_app_notifications SET read = true WHERE id = $1`,
        [notificationId],
      );

      return reply.status(200).send({ id: notificationId, read: true });
    },
  );
};

export default fp(inAppNotificationRoutes, { name: 'in-app-notification-routes' });
