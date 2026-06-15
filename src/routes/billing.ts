// Authorized by HUB-454 — GET /api/v1/billing/subscriptions/:tenantId; operator JWT; list tenant subscriptions
// Authorized by HUB-476 — GET /api/v1/billing/invoices/:tenantId; operator JWT; list tenant invoices
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../errors/AppError.js';
import { getSubscriptions } from '../services/stripeService.js';
import { getInvoices } from '../services/invoiceService.js';

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

  fastify.get(
    '/api/v1/billing/invoices/:tenantId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };

      if (!UUID_RE.test(tenantId)) {
        throw new AppError(400, 'tenantId must be a valid UUID');
      }

      const query = request.query as { productId?: string; limit?: string };
      const productId = query.productId;
      const limit = query.limit ? parseInt(query.limit, 10) : undefined;

      if (productId !== undefined && !UUID_RE.test(productId)) {
        throw new AppError(400, 'productId must be a valid UUID');
      }

      const invoices = await getInvoices(tenantId, productId, limit);
      return reply.status(200).send({ data: invoices });
    },
  );
};

export default fp(billingRoutes, { name: 'billing-routes' });
