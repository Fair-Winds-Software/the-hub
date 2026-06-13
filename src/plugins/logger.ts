// Authorized by HUB-78 — Pino structured logger plugin; must be registered first in app.ts
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

const loggerPlugin: FastifyPluginAsync = async (fastify) => {
  // AC2: inject tenant_id:null and product_id:null onto every request's child
  // logger so all 6 required fields are present from the very first log line.
  // Downstream auth middleware (HUB-98) replaces nulls with real values via:
  //   request.log = request.log.child({ tenant_id, product_id })
  fastify.addHook('onRequest', async (request) => {
    request.log = request.log.child({ tenant_id: null, product_id: null });
  });

  // Log one line per completed request (statusCode + elapsed ms).
  // disableRequestLogging:true suppresses Fastify's own request/response lines;
  // this hook is the single source of per-request telemetry.
  fastify.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { res: reply.raw, responseTime: reply.elapsedTime },
      'request completed',
    );
  });
};

// fp() escapes Fastify's plugin encapsulation so these hooks apply to the
// entire application, not just the plugin's own scope.
export default fp(loggerPlugin);
