// Authorized by HUB-594 — POST /api/v1/pricing/models/:productId (activate); GET /api/v1/pricing/models/:productId (active); operator JWT
// Authorized by HUB-595 — GET /api/v1/pricing/models/:productId/history; paginated pricing model history; operator JWT
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../errors/AppError.js';
import {
  activatePricingModel,
  getActivePricingModel,
  getPricingModelHistory,
} from '../services/pricingModelService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pricingModelRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/pricing/models/:productId — activate a new pricing model
  fastify.post(
    '/api/v1/pricing/models/:productId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { productId } = request.params as { productId: string };
      if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');

      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body.model_type !== 'string') {
        throw new AppError(400, 'model_type is required');
      }
      if (
        body.config !== undefined &&
        (typeof body.config !== 'object' || Array.isArray(body.config) || body.config === null)
      ) {
        throw new AppError(400, 'config must be an object');
      }

      const model = await activatePricingModel(
        productId,
        body.model_type,
        typeof body.currency === 'string' ? body.currency : 'USD',
        (body.config as Record<string, unknown> | undefined) ?? {},
        Array.isArray(body.tiers) ? (body.tiers as never) : undefined,
        request.operator_id!,
      );

      return reply.status(200).send({ data: model });
    },
  );

  // GET /api/v1/pricing/models/:productId — get the currently active pricing model
  fastify.get(
    '/api/v1/pricing/models/:productId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { productId } = request.params as { productId: string };
      if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');

      const model = await getActivePricingModel(productId);
      if (!model) throw new AppError(404, 'No active pricing model found for product');

      return reply.status(200).send({ data: model });
    },
  );

  // GET /api/v1/pricing/models/:productId/history — paginated pricing model history
  fastify.get(
    '/api/v1/pricing/models/:productId/history',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { productId } = request.params as { productId: string };
      if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');

      const query = request.query as { limit?: string; offset?: string };
      const limit = query.limit ? Math.min(parseInt(query.limit, 10), 100) : 20;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;

      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError(400, 'limit must be a positive integer');
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw new AppError(400, 'offset must be a non-negative integer');
      }

      const result = await getPricingModelHistory(productId, limit, offset);
      return reply.status(200).send(result);
    },
  );
};

export default fp(pricingModelRoutes, { name: 'pricing-model-routes' });
