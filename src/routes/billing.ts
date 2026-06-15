// Authorized by HUB-454 — GET /api/v1/billing/subscriptions/:tenantId; operator JWT; list tenant subscriptions
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../errors/AppError.js';
import { getSubscriptions } from '../services/stripeService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const billingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/api/v1/billing/subscriptions/:tenantId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };

      if (!UUID_RE.test(tenantId)) {
        throw new AppError(400, 'tenantId must be a valid UUID');
      }

      const subscriptions = await getSubscriptions(tenantId);
      return reply.status(200).send({ data: subscriptions });
    },
  );
};

export default fp(billingRoutes, { name: 'billing-routes' });
