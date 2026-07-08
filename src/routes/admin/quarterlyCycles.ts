// Authorized by HUB-1767 (E-V2-PP-5 S8, HUB-1729, HUB-1701) — tenant-facing
// quarterly cycle preview endpoint. Serves the current cycle info + unlocked
// quota for the tenant billing FE widget.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getQuarterlyCyclePreview } from '../../services/quarterlyCycleService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertOperator(req: FastifyRequest): void {
  if (!req.operatorUser) throw new AppError(401, 'Unauthenticated');
}
function assertUuid(id: unknown, label: string): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }
}

const quarterlyCycleRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/tenants/:tenantId/plans/:planId/quarterly-cycle
  fastify.get(
    '/api/v1/tenants/:tenantId/plans/:planId/quarterly-cycle',
    async (request, reply) => {
      assertOperator(request);
      const { tenantId, planId } = request.params as { tenantId?: unknown; planId?: unknown };
      assertUuid(tenantId, 'tenantId');
      assertUuid(planId, 'planId');
      const preview = await getQuarterlyCyclePreview(tenantId, planId);
      return reply.send({ preview });
    },
  );
};

export default quarterlyCycleRoutes;
