// Authorized by HUB-350 — GET /api/v1/products/:productId/versions; operator version catalog endpoint
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import type { ProductVersionRow } from '../db/schema/product_versions.js';

const versionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/api/v1/products/:productId/versions',
    {
      schema: {
        params: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: { type: 'string' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['supported', 'deprecated', 'sunset'] },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
          additionalProperties: false,
        },
      },
      preHandler: [fastify.authenticateOperator],
    },
    async (request, reply) => {
      const { productId } = request.params as { productId: string };
      const { status, limit = 20, offset = 0 } = request.query as {
        status?: string;
        limit?: number;
        offset?: number;
      };

      const pool = getPool();

      const COLS = `id, product_id, version, status, deprecated_at, sunset_at, release_notes, created_by, delta_data, created_at, updated_at`;
      const { rows } = status
        ? await pool.query<ProductVersionRow>(
            `SELECT ${COLS} FROM product_versions
             WHERE product_id = $1 AND status = $2
             ORDER BY created_at DESC
             LIMIT $3 OFFSET $4`,
            [productId, status, limit, offset],
          )
        : await pool.query<ProductVersionRow>(
            `SELECT ${COLS} FROM product_versions
             WHERE product_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [productId, limit, offset],
          );

      return reply.send({ data: rows, limit, offset });
    },
  );
};

export default fp(versionsRoutes, { name: 'versions-routes' });
