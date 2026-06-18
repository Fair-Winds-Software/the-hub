// Authorized by HUB-1484 — tenant discounts, credits, price-override billing endpoints; operator JWT
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { applyDiscount, removeDiscount } from '../../services/discountService.js';
import { grantCredit } from '../../services/creditService.js';
import { setPriceOverride, getCurrentOverride } from '../../services/priceOverrideService.js';
import { AppError } from '../../errors/AppError.js';

const billingFlexibilityRoutes: FastifyPluginAsync = async (fastify) => {
  // Apply a discount coupon to a tenant
  fastify.post<{ Params: { tenantId: string } }>(
    '/api/v1/billing/tenants/:tenantId/discounts',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'discountId'],
          properties: {
            productId:  { type: 'string' },
            discountId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { productId: string; discountId: string };
      const row = await applyDiscount(request.params.tenantId, body.productId, body.discountId);
      return reply.status(201).send(row);
    },
  );

  // Remove a discount from a tenant
  fastify.delete<{ Params: { tenantId: string; discountId: string }; Querystring: { productId?: string } }>(
    '/api/v1/billing/tenants/:tenantId/discounts/:discountId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      if (!request.query.productId) throw new AppError(400, 'productId query parameter is required');
      const row = await removeDiscount(
        request.params.tenantId,
        request.query.productId,
        request.params.discountId,
      );
      return reply.send(row);
    },
  );

  // Grant a credit to a tenant
  fastify.post<{ Params: { tenantId: string } }>(
    '/api/v1/billing/tenants/:tenantId/credits',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'credit_amount_cents'],
          properties: {
            productId:           { type: 'string' },
            credit_amount_cents: { type: 'number' },
            currency:            { type: 'string' },
            memo:                { type: 'string' },
            accounting_period:   { type: 'string' },
            granted_by:          { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        productId: string;
        credit_amount_cents: number;
        currency?: string;
        memo?: string;
        accounting_period?: string;
        granted_by?: string;
      };
      const row = await grantCredit(request.params.tenantId, body.productId, {
        credit_amount_cents: body.credit_amount_cents,
        currency: body.currency,
        memo: body.memo,
        accounting_period: body.accounting_period,
        granted_by: body.granted_by,
      });
      return reply.status(201).send(row);
    },
  );

  // Set a price override for a tenant+plan
  fastify.put<{ Params: { tenantId: string } }>(
    '/api/v1/billing/tenants/:tenantId/price-overrides',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'planId', 'override_amount_cents'],
          properties: {
            productId:             { type: 'string' },
            planId:                { type: 'string' },
            override_amount_cents: { type: 'number' },
            currency:              { type: 'string' },
            reason:                { type: 'string' },
            applied_by:            { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        productId: string;
        planId: string;
        override_amount_cents: number;
        currency?: string;
        reason?: string;
        applied_by?: string;
      };
      const row = await setPriceOverride(
        request.params.tenantId,
        body.productId,
        body.planId,
        {
          override_amount_cents: body.override_amount_cents,
          currency: body.currency,
          reason: body.reason,
          applied_by: body.applied_by,
        },
      );
      return reply.send(row);
    },
  );

  // Get the currently active price override for a tenant+plan
  fastify.get<{ Params: { tenantId: string; planId: string }; Querystring: { productId?: string } }>(
    '/api/v1/billing/tenants/:tenantId/price-overrides/:planId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      if (!request.query.productId) throw new AppError(400, 'productId query parameter is required');
      const override = await getCurrentOverride(
        request.params.tenantId,
        request.query.productId,
        request.params.planId,
      );
      return reply.send(override);
    },
  );
};

export default fp(billingFlexibilityRoutes, { name: 'billing-flexibility-routes' });
