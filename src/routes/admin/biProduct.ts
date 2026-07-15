// Authorized by HUB-1808 (S6 of HUB-1785) — per-product BI endpoints.
//   GET /api/v1/admin/bi/products/:productId/trends?metric=<name>&window=<w>&range=<r>
//   GET /api/v1/admin/bi/products/:productId/health
//   GET /api/v1/admin/bi/catalog  (auth-only reveal of the S1 catalog; consumed by S8)
//
// RBAC scoping (product_admin):
//   product_admin can only access products where products.tenant_id = op.tenant_id.
//   Cross-tenant productId → 403. Unknown productId (super_admin) → 404.
//   super_admin: unrestricted.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import { getCatalogEntry, listCatalog } from '../../services/bi/metricCatalog.js';
import {
  getProductHealth,
  getTrendSeries,
  type Range,
  type RollupWindow,
} from '../../services/bi/productTrendService.js';

interface OperatorAuth {
  operator_id?: string;
  role?: string;
  tenant_id?: string | null;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  return (req as unknown as { operatorUser?: OperatorAuth }).operatorUser ?? {};
}

const VALID_WINDOWS: RollupWindow[] = ['hourly', 'daily', 'monthly'];
const VALID_RANGES: Range[] = ['7d', '30d', '90d'];

/**
 * Ensures the operator may access `productId`. Returns nothing on success; throws:
 *   - 404 when the product doesn't exist (any operator).
 *   - 403 when a product_admin references a product outside their tenant.
 */
async function assertProductScope(productId: string, op: OperatorAuth): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ tenant_id: string | null }>(
    `SELECT tenant_id FROM products WHERE id = $1::uuid`,
    [productId],
  );
  if (rows.length === 0) {
    throw new AppError(404, `Unknown product '${productId}'`);
  }
  if (op.role === 'product_admin') {
    if (!op.tenant_id || rows[0]!.tenant_id !== op.tenant_id) {
      throw new AppError(403, `productId '${productId}' out of scope`);
    }
  }
}

const adminBiProductRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Params: { productId: string };
    Querystring: { metric?: string; window?: string; range?: string };
  }>('/api/v1/admin/bi/products/:productId/trends', async (req) => {
    const op = operatorFromRequest(req);
    const { productId } = req.params;
    const { metric, window, range } = req.query;
    if (!metric) throw new AppError(400, 'metric query parameter is required');
    if (!getCatalogEntry(metric)) {
      throw new AppError(400, `unknown metric '${metric}' — not in catalog`);
    }
    if (!window || !(VALID_WINDOWS as string[]).includes(window)) {
      throw new AppError(400, `window must be one of: ${VALID_WINDOWS.join(', ')}`);
    }
    if (!range || !(VALID_RANGES as string[]).includes(range)) {
      throw new AppError(400, `range must be one of: ${VALID_RANGES.join(', ')}`);
    }
    await assertProductScope(productId, op);
    return getTrendSeries({
      productId,
      metric,
      window: window as RollupWindow,
      range: range as Range,
    });
  });

  fastify.get<{ Params: { productId: string } }>(
    '/api/v1/admin/bi/products/:productId/health',
    async (req) => {
      const op = operatorFromRequest(req);
      const { productId } = req.params;
      await assertProductScope(productId, op);
      return getProductHealth({ productId });
    },
  );

  // Small catalog-reveal endpoint powers the S8 frontend metric picker. Any
  // authenticated admin operator (super_admin OR product_admin) may read it.
  fastify.get('/api/v1/admin/bi/catalog', async (req) => {
    const op = operatorFromRequest(req);
    if (op.role !== 'super_admin' && op.role !== 'product_admin') {
      throw new AppError(403, 'catalog reveal requires an admin operator');
    }
    return {
      catalog: listCatalog().map((e) => ({
        name: e.name,
        description: e.description,
        type: e.type,
        rollup: e.rollup,
        dimensions: e.dimensions,
      })),
    };
  });
};

export default adminBiProductRoutes;
