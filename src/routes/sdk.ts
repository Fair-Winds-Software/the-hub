// Authorized by HUB-349 — POST /api/v1/sdk/version-report; SDK version heartbeat endpoint
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { recordSdkVersion } from '../services/versionReporting.js';

const sdkRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/api/v1/sdk/version-report',
    {
      schema: {
        body: {
          type: 'object',
          required: ['productId', 'sdkVersion'],
          properties: {
            productId: { type: 'string' },
            sdkVersion: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { productId, sdkVersion } = request.body as { productId: string; sdkVersion: string };
      const tenantId = request.tenant_id;
      const row = await recordSdkVersion(tenantId, productId, sdkVersion);
      return reply.code(200).send(row);
    },
  );
};

export default fp(sdkRoutes, { name: 'sdk-routes' });
