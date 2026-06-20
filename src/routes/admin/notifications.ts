// Authorized by HUB-1499 — 028 migration: idx_alert_events_tenant_status_severity
// Authorized by HUB-4.1 L2 — Deep Audit DA-C2/DA-C3/DA-H2: explicit SELECT/RETURNING columns, transactions on ack/resolve
// Authorized by HUB-1500 — GET /api/v1/admin/alerts/summary/:tenantId; counts + recent 20 unacknowledged
// Authorized by HUB-1501 — admin alert ack/resolve/list delegation under operatorRbacHook
// Authorized by HUB-1502 — admin notification channel CRUD; hmac_secret masked; operatorRbacHook
// Authorized by HUB-1503 — admin escalation rule CRUD; 2-tier cap; operatorRbacHook
// Authorized by HUB-1504 — admin workflow hook CRUD; AES hmac_secret encryption + GET masking
// Authorized by HUB-1505 — integration tests for E28 admin routes
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { encryptHookSecret } from '../../services/hookDeliveryService.js';
import logger from '../../lib/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

function assertTenantAccess(
  request: { operatorUser?: { role: string; tenant_id: string | null } },
  tenantId: string,
): void {
  const op = request.operatorUser!;
  if (op.role === 'tenant_admin' && op.tenant_id !== tenantId) {
    throw new AppError(403, 'Forbidden');
  }
}

const VALID_CHANNEL_TYPES = new Set(['email', 'webhook', 'in_app']);
const VALID_STATUSES = new Set(['new', 'acknowledged', 'resolved']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

const CHANNEL_SELECT = `
  id, tenant_id, product_id, channel_type, config,
  CASE WHEN hmac_secret IS NOT NULL THEN '***' ELSE NULL END AS hmac_secret,
  enabled, created_at
`;

function validateChannelConfig(channelType: string, config: Record<string, unknown>): void {
  if (channelType === 'webhook' && typeof config.url !== 'string') {
    throw new AppError(400, 'Webhook channel requires config.url');
  }
  if (channelType === 'email' && typeof config.to !== 'string') {
    throw new AppError(400, 'Email channel requires config.to');
  }
}

interface EscalationContact {
  type: 'email' | 'sms' | 'webhook';
  value: string;
}

function validateContacts(contacts: unknown): EscalationContact[] {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new AppError(400, 'escalation_contacts must be a non-empty array');
  }
  for (const c of contacts) {
    if (!c || typeof c !== 'object') throw new AppError(400, 'Each escalation contact must be an object');
    const contact = c as Record<string, unknown>;
    if (!['email', 'sms', 'webhook'].includes(contact.type as string)) {
      throw new AppError(400, `escalation_contacts[].type must be 'email', 'sms', or 'webhook'`);
    }
    if (typeof contact.value !== 'string' || contact.value.trim() === '') {
      throw new AppError(400, 'escalation_contacts[].value must be a non-empty string');
    }
  }
  return contacts as EscalationContact[];
}

const ALERT_COLS = `id, tenant_id, product_id, alert_type, severity, payload, status, dedup_key,
  first_fired_at, last_fired_at, fire_count, acknowledged_at, resolved_at, delta_data`;

const adminNotificationsRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool();

  // ── Alert summary ──────────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/alerts/summary/:tenantId', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    assertTenantAccess(request, tenantId);

    const [{ rows: countRows }, { rows: recentRows }] = await Promise.all([
      pool.query<{ severity: string; count: string }>(
        `SELECT severity, COUNT(*) AS count
         FROM alert_events
         WHERE tenant_id = $1 AND status != 'resolved'
         GROUP BY severity`,
        [tenantId],
      ),
      pool.query(
        `SELECT ${ALERT_COLS} FROM alert_events
         WHERE tenant_id = $1 AND status = 'new'
         ORDER BY first_fired_at DESC
         LIMIT 20`,
        [tenantId],
      ),
    ]);

    const counts = { info: 0, warning: 0, critical: 0 };
    for (const row of countRows) {
      if (row.severity === 'info' || row.severity === 'warning' || row.severity === 'critical') {
        counts[row.severity] = parseInt(row.count, 10);
      }
    }

    return reply.send({ counts, recent_unacknowledged: recentRows });
  });

  // ── Alert ack / resolve / list (RBAC delegation) ──────────────────────────

  fastify.post('/api/v1/admin/alerts/:tenantId/:alertId/acknowledge', async (request, reply) => {
    const { tenantId, alertId } = request.params as { tenantId: string; alertId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(alertId, 'alertId');
    assertTenantAccess(request, tenantId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM alert_events WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [alertId, tenantId],
      );
      if (rows.length === 0) throw new AppError(404, 'Alert not found');
      const current = rows[0]!.status;
      if (current === 'acknowledged') throw new AppError(400, 'Alert is already acknowledged');
      if (current === 'resolved') throw new AppError(400, 'Cannot acknowledge a resolved alert');

      const { rows: updated } = await client.query(
        `UPDATE alert_events SET status = 'acknowledged', acknowledged_at = NOW()
         WHERE id = $1 RETURNING ${ALERT_COLS}`,
        [alertId],
      );
      await client.query('COMMIT');
      return reply.send(updated[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  fastify.post('/api/v1/admin/alerts/:tenantId/:alertId/resolve', async (request, reply) => {
    const { tenantId, alertId } = request.params as { tenantId: string; alertId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(alertId, 'alertId');
    assertTenantAccess(request, tenantId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM alert_events WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [alertId, tenantId],
      );
      if (rows.length === 0) throw new AppError(404, 'Alert not found');
      if (rows[0]!.status === 'resolved') throw new AppError(400, 'Alert is already resolved');

      const { rows: updated } = await client.query(
        `UPDATE alert_events SET status = 'resolved', resolved_at = NOW()
         WHERE id = $1 RETURNING ${ALERT_COLS}`,
        [alertId],
      );
      await client.query('COMMIT');
      return reply.send(updated[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  fastify.get('/api/v1/admin/alerts/:tenantId', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    assertTenantAccess(request, tenantId);

    const query = request.query as Record<string, string | undefined>;
    const { status, severity } = query;
    const limit = Math.min(parseInt(query.limit ?? '20', 10), 100);
    const offset = parseInt(query.offset ?? '0', 10);

    if (status && !VALID_STATUSES.has(status)) throw new AppError(400, `Invalid status: ${status}`);
    if (severity && !VALID_SEVERITIES.has(severity)) throw new AppError(400, `Invalid severity: ${severity}`);

    const params: unknown[] = [tenantId];
    let where = 'WHERE tenant_id = $1';
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    if (severity) { params.push(severity); where += ` AND severity = $${params.length}`; }

    const [{ rows: alerts }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT ${ALERT_COLS} FROM alert_events ${where} ORDER BY first_fired_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM alert_events ${where}`,
        params,
      ),
    ]);

    return reply.send({ alerts, total: parseInt(countRows[0]!.count, 10), limit, offset });
  });

  // ── Notification channel CRUD ──────────────────────────────────────────────

  fastify.post('/api/v1/admin/notifications/:tenantId/:productId/channels', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertTenantAccess(request, tenantId);

    const body = request.body as { channel_type?: string; config?: Record<string, unknown>; hmac_secret?: string; enabled?: boolean };
    const { channel_type, config = {}, hmac_secret = null, enabled = true } = body;

    if (!channel_type || !VALID_CHANNEL_TYPES.has(channel_type)) {
      throw new AppError(400, `Invalid channel_type: must be one of email, webhook, in_app`);
    }
    validateChannelConfig(channel_type, config);

    const { rows } = await pool.query<{ id: string; is_insert: boolean }>(
      `INSERT INTO notification_channels (tenant_id, product_id, channel_type, config, hmac_secret, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, product_id, channel_type)
       DO UPDATE SET config = $4, hmac_secret = $5, enabled = $6
       RETURNING id, (xmax = 0) AS is_insert`,
      [tenantId, productId, channel_type, JSON.stringify(config), hmac_secret, enabled],
    );

    const row = rows[0] as unknown as { id: string; is_insert: boolean };
    const action = row.is_insert ? 'created' : 'updated';
    const statusCode = row.is_insert ? 201 : 200;

    logger.info({ channelId: row.id, tenantId, productId, channel_type, action }, 'Admin: notification channel upserted');
    return reply.status(statusCode).send({ id: row.id, action });
  });

  fastify.get('/api/v1/admin/notifications/:tenantId/:productId/channels', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertTenantAccess(request, tenantId);

    const { rows } = await pool.query(
      `SELECT ${CHANNEL_SELECT} FROM notification_channels WHERE tenant_id = $1 AND product_id = $2 ORDER BY created_at ASC`,
      [tenantId, productId],
    );
    return reply.send({ channels: rows });
  });

  fastify.get('/api/v1/admin/notifications/:tenantId/:productId/channels/:channelId', async (request, reply) => {
    const { tenantId, productId, channelId } = request.params as { tenantId: string; productId: string; channelId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertUUID(channelId, 'channelId');
    assertTenantAccess(request, tenantId);

    const { rows } = await pool.query(
      `SELECT ${CHANNEL_SELECT} FROM notification_channels WHERE id = $1 AND tenant_id = $2 AND product_id = $3`,
      [channelId, tenantId, productId],
    );
    if (rows.length === 0) throw new AppError(404, 'Channel not found');
    return reply.send(rows[0]);
  });

  fastify.put('/api/v1/admin/notifications/:tenantId/:productId/channels/:channelId', async (request, reply) => {
    const { tenantId, productId, channelId } = request.params as { tenantId: string; productId: string; channelId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertUUID(channelId, 'channelId');
    assertTenantAccess(request, tenantId);

    const body = request.body as { config?: Record<string, unknown>; hmac_secret?: string | null; enabled?: boolean };
    const { config = {}, hmac_secret = null, enabled = true } = body;

    const { rows, rowCount } = await pool.query(
      `UPDATE notification_channels SET config = $3, hmac_secret = $4, enabled = $5
       WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      [channelId, tenantId, JSON.stringify(config), hmac_secret, enabled],
    );
    if (rowCount === 0) throw new AppError(404, 'Channel not found');
    return reply.send({ id: (rows[0] as { id: string }).id });
  });

  fastify.delete('/api/v1/admin/notifications/:tenantId/:productId/channels/:channelId', async (request, reply) => {
    const { tenantId, productId, channelId } = request.params as { tenantId: string; productId: string; channelId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertUUID(channelId, 'channelId');
    assertTenantAccess(request, tenantId);

    const { rowCount } = await pool.query(
      `DELETE FROM notification_channels WHERE id = $1 AND tenant_id = $2 AND product_id = $3`,
      [channelId, tenantId, productId],
    );
    if (rowCount === 0) throw new AppError(404, 'Channel not found');
    return reply.status(204).send();
  });

  // ── Escalation rule CRUD ───────────────────────────────────────────────────

  fastify.post('/api/v1/admin/escalation/:tenantId/:productId/rules', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertTenantAccess(request, tenantId);

    const body = request.body as {
      tier?: unknown;
      threshold_minutes?: unknown;
      alert_type?: unknown;
      escalation_contacts?: unknown;
    };
    const { tier, threshold_minutes, alert_type, escalation_contacts } = body;

    if (tier !== 1 && tier !== 2) throw new AppError(400, 'tier must be 1 or 2');
    if (typeof threshold_minutes !== 'number' || !Number.isInteger(threshold_minutes) || threshold_minutes <= 0) {
      throw new AppError(400, 'threshold_minutes must be a positive integer');
    }
    if (typeof alert_type !== 'string' || alert_type.trim() === '') {
      throw new AppError(400, 'alert_type is required');
    }
    const contacts = validateContacts(escalation_contacts);

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM escalation_rules WHERE tenant_id = $1 AND product_id = $2 AND alert_type = $3`,
      [tenantId, productId, alert_type],
    );
    if (parseInt(countRows[0]!.count, 10) >= 2) {
      throw new AppError(409, 'Escalation rule tier limit reached (max 2 tiers)');
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO escalation_rules (tenant_id, product_id, alert_type, tier, threshold_minutes, escalation_contacts)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, product_id, alert_type, tier, threshold_minutes, escalation_contacts`,
        [tenantId, productId, alert_type, tier, threshold_minutes, JSON.stringify(contacts)],
      );
      logger.info({ ruleId: (rows[0] as { id: string }).id, tenantId, productId, alert_type, tier }, 'Admin: escalation rule created');
      return reply.status(201).send(rows[0]);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') throw new AppError(409, 'Escalation rule tier limit reached (max 2 tiers)');
      throw err;
    }
  });

  fastify.get('/api/v1/admin/escalation/:tenantId/:productId/rules', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertTenantAccess(request, tenantId);

    const { rows } = await pool.query(
      `SELECT id, tenant_id, product_id, alert_type, tier, threshold_minutes, escalation_contacts
       FROM escalation_rules
       WHERE tenant_id = $1 AND product_id = $2
       ORDER BY alert_type ASC, tier ASC`,
      [tenantId, productId],
    );
    return reply.send({ rules: rows });
  });

  fastify.delete('/api/v1/admin/escalation/:tenantId/:productId/rules/:ruleId', async (request, reply) => {
    const { tenantId, productId, ruleId } = request.params as { tenantId: string; productId: string; ruleId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertUUID(ruleId, 'ruleId');
    assertTenantAccess(request, tenantId);

    const { rowCount } = await pool.query(
      `DELETE FROM escalation_rules WHERE id = $1 AND tenant_id = $2 AND product_id = $3`,
      [ruleId, tenantId, productId],
    );
    if (rowCount === 0) throw new AppError(404, 'Escalation rule not found');
    return reply.status(204).send();
  });

  // ── Workflow hook CRUD ─────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/hooks/:tenantId', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    assertTenantAccess(request, tenantId);

    const body = request.body as {
      trigger_event_type?: unknown;
      action_config?: unknown;
      product_id?: unknown;
      enabled?: unknown;
    };
    const { trigger_event_type, action_config, product_id, enabled } = body;

    if (typeof trigger_event_type !== 'string' || trigger_event_type.trim() === '') {
      throw new AppError(400, 'trigger_event_type is required');
    }
    const cfg = action_config as Record<string, unknown> | undefined;
    if (!cfg || typeof cfg.url !== 'string' || !cfg.url.startsWith('https://')) {
      throw new AppError(400, 'action_config.url must be an https:// URL');
    }
    if (typeof cfg.hmac_secret !== 'string' || cfg.hmac_secret.trim() === '') {
      throw new AppError(400, 'action_config.hmac_secret is required');
    }
    if (product_id !== undefined && product_id !== null) {
      assertUUID(product_id as string, 'product_id');
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new AppError(400, 'enabled must be a boolean');
    }

    const encryptedSecret = encryptHookSecret(cfg.hmac_secret as string);
    const actionConfig = { url: cfg.url, hmac_secret: encryptedSecret };

    const { rows } = await pool.query(
      `INSERT INTO workflow_hooks (tenant_id, product_id, trigger_event_type, action_type, action_config, enabled)
       VALUES ($1, $2, $3, 'webhook', $4, $5)
       RETURNING id, tenant_id, product_id, trigger_event_type, action_type,
                 jsonb_set(action_config, '{hmac_secret}', '"***"') AS action_config,
                 enabled, created_at`,
      [tenantId, product_id ?? null, trigger_event_type, JSON.stringify(actionConfig), enabled ?? true],
    );

    const row = rows[0] as { id: string };
    logger.info({ hookId: row.id, tenantId, trigger_event_type }, 'Admin: workflow hook registered');
    return reply.status(201).send(row);
  });

  fastify.get('/api/v1/admin/hooks/:tenantId', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    assertTenantAccess(request, tenantId);

    const { rows } = await pool.query(
      `SELECT id, tenant_id, product_id, trigger_event_type, action_type,
              jsonb_set(action_config, '{hmac_secret}', '"***"') AS action_config,
              enabled, created_at
       FROM workflow_hooks
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [tenantId],
    );
    return reply.send(rows);
  });

  fastify.delete('/api/v1/admin/hooks/:tenantId/:hookId', async (request, reply) => {
    const { tenantId, hookId } = request.params as { tenantId: string; hookId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(hookId, 'hookId');
    assertTenantAccess(request, tenantId);

    const { rowCount } = await pool.query(
      `DELETE FROM workflow_hooks WHERE id = $1 AND tenant_id = $2`,
      [hookId, tenantId],
    );
    if (rowCount === 0) throw new AppError(404, 'Hook not found');
    return reply.status(204).send();
  });

  fastify.get('/api/v1/admin/hooks/:tenantId/:hookId/executions', async (request, reply) => {
    const { tenantId, hookId } = request.params as { tenantId: string; hookId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(hookId, 'hookId');
    assertTenantAccess(request, tenantId);

    const { rows: hookRows } = await pool.query(
      `SELECT id FROM workflow_hooks WHERE id = $1 AND tenant_id = $2`,
      [hookId, tenantId],
    );
    if (hookRows.length === 0) throw new AppError(404, 'Hook not found');

    const { rows } = await pool.query(
      `SELECT id, hook_id, alert_event_id, status, status_code, duration_ms, error, attempted_at
       FROM workflow_hook_executions
       WHERE hook_id = $1
       ORDER BY attempted_at DESC`,
      [hookId],
    );
    return reply.send(rows);
  });
};

export default adminNotificationsRoutes;
