// Authorized by HUB-1098 — GET/PUT alert_rules endpoints; admin-only
// Authorized by HUB-1102 — notification list, acknowledge, acknowledge-all endpoints
// Authorized by HUB-1365 — in-app notification center served by notification list endpoint
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMMUTABLE_RULE_FIELDS = new Set(['id', 'created_at', 'rule_type', 'product_id']);

const adminComplianceAlertsRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool();

  // ── Alert rules ────────────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/compliance/alerts/rules', async (_request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, product_id, rule_type, threshold_value, escalation_delay_hours,
              assignee_account_id, fallback_assignee_account_id, enabled, created_at
       FROM alert_rules
       ORDER BY rule_type ASC, product_id NULLS FIRST`,
    );
    return reply.send(rows);
  });

  fastify.put('/api/v1/admin/compliance/alerts/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) throw new AppError(400, 'id must be a valid UUID');

    const b = request.body as Record<string, unknown>;
    const immutableAttempt = Object.keys(b).find((k) => IMMUTABLE_RULE_FIELDS.has(k));
    if (immutableAttempt) {
      throw new AppError(400, `Field '${immutableAttempt}' is immutable and cannot be updated`);
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (b.threshold_value !== undefined) {
      params.push(b.threshold_value);
      sets.push(`threshold_value = $${params.length}`);
    }
    if (b.escalation_delay_hours !== undefined) {
      params.push(b.escalation_delay_hours);
      sets.push(`escalation_delay_hours = $${params.length}`);
    }
    if (b.assignee_account_id !== undefined) {
      params.push(b.assignee_account_id);
      sets.push(`assignee_account_id = $${params.length}`);
    }
    if (b.fallback_assignee_account_id !== undefined) {
      params.push(b.fallback_assignee_account_id);
      sets.push(`fallback_assignee_account_id = $${params.length}`);
    }
    if (b.enabled !== undefined) {
      params.push(b.enabled);
      sets.push(`enabled = $${params.length}`);
    }

    if (sets.length === 0) throw new AppError(400, 'No fields to update');

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE alert_rules SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (rows.length === 0) throw new AppError(404, 'Alert rule not found');
    return reply.send(rows[0]);
  });

  // ── Notifications ──────────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/compliance/alerts/notifications', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 200);
    const offset = parseInt(q.offset ?? '0', 10);
    const unread = q.unread === 'true';

    const { rows } = await pool.query(
      `SELECT n.id, n.product_id, n.control_id, n.alert_type, n.severity,
              n.payload, n.channels_targeted, n.fired_at,
              (a.notification_id IS NOT NULL) AS is_acknowledged,
              a.acknowledged_by, a.acknowledged_at,
              COUNT(*) OVER() AS total_count
       FROM alert_notifications n
       LEFT JOIN alert_acknowledgments a ON a.notification_id = n.id
       WHERE ('IN_APP' = ANY(n.channels_targeted))
         AND ($1 = false OR a.notification_id IS NULL)
       ORDER BY n.fired_at DESC
       LIMIT $2 OFFSET $3`,
      [unread, limit, offset],
    );

    const total = rows.length > 0 ? parseInt((rows[0] as { total_count: string }).total_count, 10) : 0;
    const notifications = rows.map(({ total_count: _tc, ...rest }) => rest);
    return reply.send({ notifications, total });
  });

  fastify.post(
    '/api/v1/admin/compliance/alerts/notifications/:id/acknowledge',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) throw new AppError(400, 'id must be a valid UUID');

      const op = request.operatorUser!;
      const acknowledgedBy = op.operator_id ?? 'unknown';

      // Verify notification exists
      const { rows: notif } = await pool.query(
        `SELECT id FROM alert_notifications WHERE id = $1`,
        [id],
      );
      if (notif.length === 0) throw new AppError(404, 'Notification not found');

      const { rows, rowCount } = await pool.query<{ notification_id: string }>(
        `INSERT INTO alert_acknowledgments (notification_id, acknowledged_by)
         VALUES ($1, $2)
         ON CONFLICT (notification_id) DO NOTHING
         RETURNING notification_id`,
        [id, acknowledgedBy],
      );

      if (rowCount === 0) throw new AppError(409, 'Notification already acknowledged');
      return reply.status(200).send({ notification_id: rows[0]!.notification_id, acknowledged: true });
    },
  );

  fastify.post(
    '/api/v1/admin/compliance/alerts/notifications/acknowledge-all',
    async (request, reply) => {
      const op = request.operatorUser!;
      const acknowledgedBy = op.operator_id ?? 'unknown';

      const { rowCount } = await pool.query(
        `INSERT INTO alert_acknowledgments (notification_id, acknowledged_by)
         SELECT n.id, $1
         FROM alert_notifications n
         WHERE 'IN_APP' = ANY(n.channels_targeted)
           AND NOT EXISTS (
             SELECT 1 FROM alert_acknowledgments a WHERE a.notification_id = n.id
           )
         ON CONFLICT (notification_id) DO NOTHING`,
        [acknowledgedBy],
      );

      return reply.send({ acknowledged_count: rowCount ?? 0 });
    },
  );
};

export default adminComplianceAlertsRoutes;
