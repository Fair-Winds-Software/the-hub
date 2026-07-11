// Authorized by HUB-1781 (S8 of HUB-1773) — admin connections routes: mode toggle for
// external-app connections. Currently only Stripe; the connections concept is intentionally
// generic so future Plaid / other integrations register here too.
//
// Endpoints (both inside adminRoutesPlugin's RBAC scope; require operator auth):
//   GET  /api/v1/admin/connections/stripe/mode  → current mode
//   PUT  /api/v1/admin/connections/stripe/mode  → flip mode
//
// Health/status signal + UI indicator are S9 (HUB-1782).
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getStripeMode, setStripeMode, type StripeMode } from '../../stripe/registry.js';

interface OperatorAuth {
  operator_id?: string;
  role?: string;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  const op = (req as unknown as { operator?: OperatorAuth }).operator;
  return op ?? {};
}

const adminConnectionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/admin/connections/stripe/mode', async (req) => {
    // Any authenticated operator can read the current mode.
    void req;
    return { mode: getStripeMode() };
  });

  fastify.put<{ Body: { mode: string } }>(
    '/api/v1/admin/connections/stripe/mode',
    async (req, reply) => {
      const { mode } = req.body ?? {};
      if (mode !== 'live' && mode !== 'mock') {
        throw new AppError(400, "mode must be 'live' or 'mock'");
      }
      const op = operatorFromRequest(req);
      await setStripeMode(mode as StripeMode, {
        operator_id: op.operator_id ?? null,
        actor_type: 'operator',
      });
      return reply.status(200).send({ mode });
    },
  );
};

export default adminConnectionsRoutes;
