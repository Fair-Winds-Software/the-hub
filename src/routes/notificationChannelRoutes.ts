// Authorized by HUB-766 — CRUD for notification_channels; hmac_secret masked at SQL level; operator JWT
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CHANNEL_TYPES = new Set(['email', 'webhook', 'in_app']);

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

function validateChannelConfig(channelType: string, config: Record<string, unknown>): void {
  if (channelType === 'webhook' && typeof config.url !== 'string') {
    throw new AppError(400, 'Webhook channel requires config.url');
  }
  if (channelType === 'email' && typeof config.to !== 'string') {
    throw new AppError(400, 'Email channel requires config.to');
  }
}

// hmac_secret is masked in SELECT projection — never exposed in plaintext
const CHANNEL_SELECT = `
  id, tenant_id, product_id, channel_type, config,
  CASE WHEN hmac_secret IS NOT NULL THEN '***' ELSE NULL END AS hmac_secret,
  enabled, created_at
`;

const notificationChannelRoutes: FastifyPluginAsync = async (fastify) => {
  // POST — upsert channel config
  fastify.post(
    '/api/v1/notifications/:tenantId/:productId/channels',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, productId } = request.params as { tenantId: string; productId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');

      const body = request.body as { channel_type?: string; config?: Record<string, unknown>; hmac_secret?: string; enabled?: boolean };
      const { channel_type, config = {}, hmac_secret = null, enabled = true } = body;

      if (!channel_type || !VALID_CHANNEL_TYPES.has(channel_type)) {
        throw new AppError(400, `Invalid channel_type: must be one of email, webhook, in_app`);
      }
      validateChannelConfig(channel_type, config);

      const pool = getPool();
      const { rows, rowCount: _rowCount } = await pool.query<{ id: string }>(
        `INSERT INTO notification_channels (tenant_id, product_id, channel_type, config, hmac_secret, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, product_id, channel_type)
         DO UPDATE SET config = $4, hmac_secret = $5, enabled = $6
         RETURNING id, (xmax = 0) AS is_insert`,
        [tenantId, productId, channel_type, JSON.stringify(config), hmac_secret, enabled],
      );

      const row = rows[0] as unknown as { id: string; is_insert: boolean };
      const action = row.is_insert ? 'created' : 'updated';
      const status = row.is_insert ? 201 : 200;

      logger.info({ channelId: row.id, tenantId, productId, channel_type, action }, 'Notification channel upserted');
      return reply.status(status).send({ id: row.id, action });
    },
  );

  // GET — list all channels (hmac_secret masked)
  fastify.get(
    '/api/v1/notifications/:tenantId/:productId/channels',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, productId } = request.params as { tenantId: string; productId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT ${CHANNEL_SELECT} FROM notification_channels WHERE tenant_id = $1 AND product_id = $2 ORDER BY created_at ASC`,
        [tenantId, productId],
      );
      return reply.status(200).send({ channels: rows });
    },
  );

  // GET — single channel (hmac_secret masked)
  fastify.get(
    '/api/v1/notifications/:tenantId/:productId/channels/:channelId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, productId, channelId } = request.params as { tenantId: string; productId: string; channelId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');
      assertUUID(channelId, 'channelId');

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT ${CHANNEL_SELECT} FROM notification_channels WHERE id = $1 AND tenant_id = $2 AND product_id = $3`,
        [channelId, tenantId, productId],
      );
      if (rows.length === 0) throw new AppError(404, 'Channel not found');
      return reply.status(200).send(rows[0]);
    },
  );

  // PUT — full update
  fastify.put(
    '/api/v1/notifications/:tenantId/:productId/channels/:channelId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, productId, channelId } = request.params as { tenantId: string; productId: string; channelId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');
      assertUUID(channelId, 'channelId');

      const body = request.body as { config?: Record<string, unknown>; hmac_secret?: string | null; enabled?: boolean };
      const { config = {}, hmac_secret = null, enabled = true } = body;

      const pool = getPool();
      const { rows, rowCount } = await pool.query(
        `UPDATE notification_channels SET config = $3, hmac_secret = $4, enabled = $5
         WHERE id = $1 AND tenant_id = $2
         RETURNING id`,
        [channelId, tenantId, JSON.stringify(config), hmac_secret, enabled],
      );
      if (rowCount === 0) throw new AppError(404, 'Channel not found');
      return reply.status(200).send({ id: (rows[0] as { id: string }).id });
    },
  );

  // DELETE
  fastify.delete(
    '/api/v1/notifications/:tenantId/:productId/channels/:channelId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, productId, channelId } = request.params as { tenantId: string; productId: string; channelId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');
      assertUUID(channelId, 'channelId');

      const pool = getPool();
      const { rowCount } = await pool.query(
        `DELETE FROM notification_channels WHERE id = $1 AND tenant_id = $2 AND product_id = $3`,
        [channelId, tenantId, productId],
      );
      if (rowCount === 0) throw new AppError(404, 'Channel not found');
      return reply.status(204).send();
    },
  );
};

export default fp(notificationChannelRoutes, { name: 'notification-channel-routes' });
