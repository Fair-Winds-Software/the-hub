// Authorized by HUB-1492 — POST plan-change + GET plan-change history; D-002 next_cycle default
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { schedulePlanChange, getPlanChangeHistory } from '../../services/planChangeService.js';
import { AppError } from '../../errors/AppError.js';

const planChangeRoutes: FastifyPluginAsync = async (fastify) => {
  // Schedule a plan change for a tenant-product pair
  fastify.post<{ Params: { tenantId: string; productId: string } }>(
    '/api/v1/billing/subscriptions/:tenantId/:productId/plan-change',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['targetPlanId', 'reason'],
          properties: {
            targetPlanId:  { type: 'string' },
            effectiveFrom: { type: 'string', enum: ['immediate', 'next_cycle'] },
            reason:        { type: 'string' },
            appliedBy:     { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        targetPlanId: string;
        effectiveFrom?: 'immediate' | 'next_cycle';
        reason: string;
        appliedBy?: string;
      };
      if (!body.targetPlanId) throw new AppError(400, 'targetPlanId is required');
      const effectiveFrom = body.effectiveFrom ?? 'next_cycle';
      const row = await schedulePlanChange(
        request.params.tenantId,
        request.params.productId,
        body.targetPlanId,
        effectiveFrom,
        body.reason,
        body.appliedBy,
      );
      return reply.status(201).send(row);
    },
  );

  // Get full plan change history for a tenant-product pair
  fastify.get<{ Params: { tenantId: string; productId: string } }>(
    '/api/v1/billing/subscriptions/:tenantId/:productId/plan-change/history',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const rows = await getPlanChangeHistory(
        request.params.tenantId,
        request.params.productId,
      );
      return reply.send(rows);
    },
  );
};

export default fp(planChangeRoutes, { name: 'plan-change-routes' });
