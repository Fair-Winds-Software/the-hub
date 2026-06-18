// Authorized by HUB-1469 — POST/GET/PATCH /api/v1/catalog/plans; operator JWT auth; Fastify fp() plugin
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { createPlan, archivePlan, getPlans } from '../../services/planCatalogService.js';

const catalogPlanRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/api/v1/catalog/plans',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'key', 'name', 'billingType'],
          properties: {
            productId:        { type: 'string' },
            key:              { type: 'string' },
            name:             { type: 'string' },
            description:      { type: 'string' },
            billingType:      { type: 'string', enum: ['flat_rate', 'per_seat', 'metered', 'tiered', 'one_time'] },
            billingInterval:  { type: 'string', enum: ['month', 'quarter', 'year', 'one_time'] },
            unitAmountCents:  { type: 'number' },
            tiers:            { type: 'array' },
            entitlements:     { type: 'object' },
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
        billingType: string;
        billingInterval?: string;
        unitAmountCents?: number;
        tiers?: Array<{ upTo: number | null; unitAmount: number }>;
        entitlements?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      };
      const plan = await createPlan(body.productId, {
        key: body.key,
        name: body.name,
        description: body.description,
        billingType: body.billingType as import('../../services/planCatalogService.js').BillingType,
        billingInterval: body.billingInterval as import('../../services/planCatalogService.js').BillingInterval | undefined,
        unitAmountCents: body.unitAmountCents,
        tiers: body.tiers,
        entitlements: body.entitlements,
        metadata: body.metadata,
      });
      return reply.status(201).send(plan);
    },
  );

  fastify.get<{ Params: { productId: string }; Querystring: { includeArchived?: string } }>(
    '/api/v1/catalog/plans/:productId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const plans = await getPlans(request.params.productId, {
        includeArchived: request.query.includeArchived === 'true',
      });
      return reply.send(plans);
    },
  );

  fastify.patch<{ Params: { planId: string } }>(
    '/api/v1/catalog/plans/:planId/archive',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          properties: {
            reason:     { type: 'string' },
            archivedBy: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { reason?: string; archivedBy?: string };
      const plan = await archivePlan(request.params.planId, body.reason, body.archivedBy);
      return reply.send(plan);
    },
  );
};

export default fp(catalogPlanRoutes, { name: 'catalog-plans-routes' });
