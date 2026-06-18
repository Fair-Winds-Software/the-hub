// Authorized by HUB-1477 — POST/GET/DELETE /api/v1/billing/tenants/:tenantId/add-ons; operator JWT auth
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { activateAddOn, deactivateAddOn, listActiveAddOns } from '../../services/addOnService.js';
import { AppError } from '../../errors/AppError.js';

const tenantAddOnRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { tenantId: string } }>(
    '/api/v1/billing/tenants/:tenantId/add-ons',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'addOnId'],
          properties: {
            productId: { type: 'string' },
            addOnId:   { type: 'string' },
            quantity:  { type: 'number' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { productId: string; addOnId: string; quantity?: number };
      const row = await activateAddOn(
        request.params.tenantId,
        body.productId,
        body.addOnId,
        body.quantity,
      );
      return reply.status(201).send(row);
    },
  );

  fastify.get<{ Params: { tenantId: string }; Querystring: { productId?: string } }>(
    '/api/v1/billing/tenants/:tenantId/add-ons',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      if (!request.query.productId) {
        throw new AppError(400, 'productId query parameter is required');
      }
      const rows = await listActiveAddOns(request.params.tenantId, request.query.productId);
      return reply.send(rows);
    },
  );

  fastify.delete<{ Params: { tenantId: string; addOnId: string } }>(
    '/api/v1/billing/tenants/:tenantId/add-ons/:addOnId',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { productId: string };
      const row = await deactivateAddOn(
        request.params.tenantId,
        body.productId,
        request.params.addOnId,
      );
      return reply.send(row);
    },
  );
};

export default fp(tenantAddOnRoutes, { name: 'tenant-add-ons-routes' });
