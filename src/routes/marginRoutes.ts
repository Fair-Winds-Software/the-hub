// Authorized by HUB-657 — POST + GET /api/v1/pricing/margin-config/:productId; operator JWT auth
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const marginRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/pricing/margin-config/:productId — upsert margin floor configuration
  fastify.post(
    '/api/v1/pricing/margin-config/:productId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { productId } = request.params as { productId: string };
      if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');

      const body = request.body as Record<string, unknown> | null;
      if (!body) throw new AppError(400, 'Request body is required');

      if (typeof body.floor_percentage !== 'number') {
        throw new AppError(400, 'floor_percentage is required and must be a number');
      }
      if (typeof body.alert_threshold_percentage !== 'number') {
        throw new AppError(400, 'alert_threshold_percentage is required and must be a number');
      }
      if (typeof body.enabled !== 'boolean') {
        throw new AppError(400, 'enabled is required and must be a boolean');
      }

      const floorPct = body.floor_percentage;
      const alertPct = body.alert_threshold_percentage;

      if (floorPct < 0 || floorPct > 100) {
        throw new AppError(400, 'floor_percentage must be between 0 and 100');
      }
      if (alertPct < 0 || alertPct > 100) {
        throw new AppError(400, 'alert_threshold_percentage must be between 0 and 100');
      }

      const pool = getPool();
      const { rows } = await pool.query<{
        product_id: string;
        floor_percentage: string;
        alert_threshold_percentage: string;
        enabled: boolean;
        updated_at: Date;
      }>(
        `INSERT INTO margin_configs
           (product_id, floor_percentage, alert_threshold_percentage, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id) DO UPDATE
           SET floor_percentage            = EXCLUDED.floor_percentage,
               alert_threshold_percentage  = EXCLUDED.alert_threshold_percentage,
               enabled                     = EXCLUDED.enabled,
               updated_at                  = NOW()
         RETURNING product_id, floor_percentage, alert_threshold_percentage, enabled, updated_at`,
        [productId, floorPct, alertPct, body.enabled, request.operator_id ?? null],
      );

      const row = rows[0]!;
      return reply.status(200).send({
        productId: row.product_id,
        floor_percentage: parseFloat(row.floor_percentage),
        alert_threshold_percentage: parseFloat(row.alert_threshold_percentage),
        enabled: row.enabled,
        updatedAt: row.updated_at.toISOString(),
      });
    },
  );

  // GET /api/v1/pricing/margin-config/:productId — retrieve current margin config
  fastify.get(
    '/api/v1/pricing/margin-config/:productId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { productId } = request.params as { productId: string };
      if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');

      const pool = getPool();
      const { rows } = await pool.query<{
        product_id: string;
        floor_percentage: string;
        alert_threshold_percentage: string;
        enabled: boolean;
        updated_at: Date;
      }>(
        `SELECT product_id, floor_percentage, alert_threshold_percentage, enabled, updated_at
           FROM margin_configs
          WHERE product_id = $1`,
        [productId],
      );

      if (rows.length === 0) throw new AppError(404, 'No margin config found for product');

      const row = rows[0]!;
      return reply.status(200).send({
        productId: row.product_id,
        floor_percentage: parseFloat(row.floor_percentage),
        alert_threshold_percentage: parseFloat(row.alert_threshold_percentage),
        enabled: row.enabled,
        updatedAt: row.updated_at.toISOString(),
      });
    },
  );
};

export default fp(marginRoutes, { name: 'margin-routes' });
