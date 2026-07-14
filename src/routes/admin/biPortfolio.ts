// Authorized by HUB-1807 (S5 of HUB-1785) — GET /api/v1/admin/bi/portfolio/summary.
// Portfolio-wide MRR/DAU/churn + per-product breakdown. In-process 60s cache: since
// rollups update at most hourly, hitting the DB on every dashboard refresh is
// unnecessary. Cache is trivial (module-local Map with expiry) — no Redis.
//
// RBAC: super_admin only (portfolio-wide numbers).
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { computePortfolioSummary, type PortfolioSummary } from '../../services/bi/portfolioSummaryService.js';

const CACHE_TTL_MS = 60_000;

interface CachedSummary {
  result: PortfolioSummary;
  expiresAt: number;
}

let _cache: CachedSummary | null = null;

/** Test-only: clear the in-process cache. */
export function _resetPortfolioSummaryCacheForTest(): void {
  _cache = null;
}

interface OperatorAuth {
  role?: string;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  return (req as unknown as { operator?: OperatorAuth }).operator ?? {};
}

const adminBiPortfolioRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/admin/bi/portfolio/summary', async (req) => {
    const op = operatorFromRequest(req);
    if (op.role !== 'super_admin') {
      throw new AppError(403, 'Portfolio summary requires super_admin');
    }

    const now = Date.now();
    if (_cache && _cache.expiresAt > now) {
      return _cache.result;
    }
    const result = await computePortfolioSummary(new Date(now));
    _cache = { result, expiresAt: now + CACHE_TTL_MS };
    return result;
  });
};

export default adminBiPortfolioRoutes;
