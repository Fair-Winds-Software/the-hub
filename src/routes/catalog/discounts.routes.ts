// Authorized by HUB-1484 — POST/GET /api/v1/catalog/discounts; operator JWT auth; Fastify fp() plugin
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { createDiscount, listDiscounts } from '../../services/discountService.js';

const catalogDiscountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/api/v1/catalog/discounts',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'name', 'discount_type', 'duration'],
          properties: {
            productId:           { type: 'string' },
            name:                { type: 'string' },
            discount_type:       { type: 'string', enum: ['percent', 'amount'] },
            percent_off:         { type: 'number' },
            amount_off_cents:    { type: 'number' },
            currency:            { type: 'string' },
            duration:            { type: 'string', enum: ['once', 'repeating', 'forever'] },
            duration_in_months:  { type: 'number' },
            created_by:          { type: 'string' },
            metadata:            { type: 'object' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        productId: string;
        name: string;
        discount_type: 'percent' | 'amount';
        percent_off?: number;
        amount_off_cents?: number;
        currency?: string;
        duration: 'once' | 'repeating' | 'forever';
        duration_in_months?: number;
        created_by?: string;
        metadata?: Record<string, unknown>;
      };
      const discount = await createDiscount(body.productId, {
        name: body.name,
        discount_type: body.discount_type,
        percent_off: body.percent_off,
        amount_off_cents: body.amount_off_cents,
        currency: body.currency,
        duration: body.duration,
        duration_in_months: body.duration_in_months,
        created_by: body.created_by,
        metadata: body.metadata,
      });
      return reply.status(201).send(discount);
    },
  );

  fastify.get<{ Params: { productId: string } }>(
    '/api/v1/catalog/discounts/:productId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const discounts = await listDiscounts(request.params.productId);
      return reply.send(discounts);
    },
  );
};

export default fp(catalogDiscountRoutes, { name: 'catalog-discounts-routes' });
