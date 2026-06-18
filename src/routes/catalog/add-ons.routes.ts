// Authorized by HUB-1477 — POST/GET/PATCH /api/v1/catalog/add-ons; operator JWT auth; Fastify fp() plugin
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import {
  createAddOn,
  archiveAddOn,
  activateAddOnDefinition,
  listAddOnsByProduct,
} from '../../services/addOnService.js';

const catalogAddOnRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/api/v1/catalog/add-ons',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'key', 'name', 'billingType', 'unitAmountCents'],
          properties: {
            productId:        { type: 'string' },
            key:              { type: 'string' },
            name:             { type: 'string' },
            description:      { type: 'string' },
            billingType:      { type: 'string', enum: ['recurring', 'one_time'] },
            billingInterval:  { type: 'string', enum: ['month', 'quarter', 'year', 'one_time'] },
            unitAmountCents:  { type: 'number' },
            metadata:         { type: 'object' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        productId: string;
        key: string;
        name: string;
        description?: string;
        billingType: 'recurring' | 'one_time';
        billingInterval?: 'month' | 'quarter' | 'year' | 'one_time';
        unitAmountCents: number;
        metadata?: Record<string, unknown>;
      };
      const addOn = await createAddOn(body.productId, {
        key: body.key,
        name: body.name,
        description: body.description,
        billingType: body.billingType,
        billingInterval: body.billingInterval,
        unitAmountCents: body.unitAmountCents,
        metadata: body.metadata,
      });
      return reply.status(201).send(addOn);
    },
  );

  fastify.get<{ Params: { productId: string }; Querystring: { includeInactive?: string } }>(
    '/api/v1/catalog/add-ons/:productId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const addOns = await listAddOnsByProduct(request.params.productId, {
        includeInactive: request.query.includeInactive === 'true',
      });
      return reply.send(addOns);
    },
  );

  fastify.patch<{ Params: { addOnId: string } }>(
    '/api/v1/catalog/add-ons/:addOnId/activate',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const addOn = await activateAddOnDefinition(request.params.addOnId);
      return reply.send(addOn);
    },
  );

  fastify.patch<{ Params: { addOnId: string } }>(
    '/api/v1/catalog/add-ons/:addOnId/archive',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const addOn = await archiveAddOn(request.params.addOnId);
      return reply.send(addOn);
    },
  );
};

export default fp(catalogAddOnRoutes, { name: 'catalog-add-ons-routes' });
