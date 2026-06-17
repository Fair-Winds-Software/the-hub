// Authorized by HUB-1057 — compliance dashboard routes: overview, product detail, posture trend
// Authorized by HUB-1062 — GET /dashboard/overview serves platform-level readiness UI
// Authorized by HUB-1065 — GET /dashboard/products/:productId serves per-product control detail UI
// Authorized by HUB-1069 — GET /dashboard/products/:productId/trend serves posture trend chart
import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import {
  getDashboardOverview,
  getProductDashboardDetail,
  getProductTrend,
} from '../../services/complianceDashboardService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_WINDOWS = [30, 60, 90] as const;

async function assertProductAccess(
  request: { operatorUser?: { role: string; tenant_id: string | null } },
  productId: string,
  pool: Pool,
): Promise<void> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM products WHERE id = $1 AND active = true`,
    [productId],
  );
  if (rows.length === 0) throw new AppError(404, 'Product not found');
  const op = request.operatorUser!;
  if (op.role !== 'super_admin' && op.tenant_id !== rows[0]!.tenant_id) {
    throw new AppError(403, 'Forbidden');
  }
}

const adminComplianceDashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool();

  fastify.get('/api/v1/admin/compliance/dashboard/overview', async (request, reply) => {
    const op = request.operatorUser!;
    const tenantId = op.role === 'super_admin' ? null : op.tenant_id;
    return reply.send(await getDashboardOverview(tenantId));
  });

  fastify.get('/api/v1/admin/compliance/dashboard/products/:productId', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');
    await assertProductAccess(request, productId, pool);
    return reply.send(await getProductDashboardDetail(productId));
  });

  fastify.get('/api/v1/admin/compliance/dashboard/products/:productId/trend', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    if (!UUID_RE.test(productId)) throw new AppError(400, 'productId must be a valid UUID');
    const q = request.query as Record<string, string | undefined>;
    const rawWindow = parseInt(q.window ?? '30', 10);
    if (!VALID_WINDOWS.includes(rawWindow as 30 | 60 | 90)) {
      throw new AppError(400, 'window must be 30, 60, or 90');
    }
    await assertProductAccess(request, productId, pool);
    return reply.send(await getProductTrend(productId, rawWindow as 30 | 60 | 90));
  });
};

export default adminComplianceDashboardRoutes;
