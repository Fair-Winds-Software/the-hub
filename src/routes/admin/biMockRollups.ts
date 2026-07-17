// Dev-only BI rollup seeder.
//   POST /api/v1/admin/bi/mock-rollups   — seed synthetic rollups
//   DELETE /api/v1/admin/bi/mock-rollups — wipe the seeded rollups
// Super_admin gated. Also invalidates the portfolio-summary cache so the
// dashboard reflects the seeded data on the next poll without waiting 60s.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  seedMockRollups,
  clearMockRollups,
} from '../../services/bi/mockRollupSeedService.js';
import { _resetPortfolioSummaryCacheForTest } from './biPortfolio.js';

interface OperatorAuth {
  role?: string;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  return (req as unknown as { operatorUser?: OperatorAuth }).operatorUser ?? {};
}

const adminBiMockRollupsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/admin/bi/mock-rollups', async (req) => {
    const op = operatorFromRequest(req);
    if (op.role !== 'super_admin') {
      throw new AppError(403, 'BI mock rollup seed requires super_admin');
    }
    const body = (req.body ?? {}) as { product_limit?: unknown; days?: unknown };
    const productLimit =
      typeof body.product_limit === 'number' && body.product_limit > 0
        ? Math.min(50, Math.floor(body.product_limit))
        : 10;
    const days =
      typeof body.days === 'number' && body.days > 0
        ? Math.min(90, Math.floor(body.days))
        : 30;
    const result = await seedMockRollups({ product_limit: productLimit, days });
    _resetPortfolioSummaryCacheForTest();
    return result;
  });

  fastify.delete('/api/v1/admin/bi/mock-rollups', async (req) => {
    const op = operatorFromRequest(req);
    if (op.role !== 'super_admin') {
      throw new AppError(403, 'BI mock rollup wipe requires super_admin');
    }
    const result = await clearMockRollups();
    _resetPortfolioSummaryCacheForTest();
    return result;
  });
};

export default adminBiMockRollupsRoutes;
