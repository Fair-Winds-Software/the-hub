// Authorized by HUB-1103 — POST product registration; client_secret returned once on creation
// Authorized by HUB-1104 — GET list and detail; client_secret suppressed
// Authorized by HUB-1105 — PUT rotate-secret; atomic; new secret returned once
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  registerProduct,
  listProducts,
  getProduct,
  rotateProductSecret,
} from '../../services/products.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUUID(v: string, label: string): void {
  if (!UUID_RE.test(v)) throw new AppError(400, `${label} must be a valid UUID`);
}

function assertTenantAccess(
  request: { operatorUser?: { role: string; tenant_id: string | null } },
  tenantId: string,
): void {
  const op = request.operatorUser!;
  if (op.role === 'tenant_admin' && op.tenant_id !== tenantId) {
    throw new AppError(403, 'Forbidden');
  }
}

const adminProductRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/admin/tenants/:tenantId/products', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    assertTenantAccess(request, tenantId);
    const body = request.body as Record<string, unknown> | null;
    const { name } = body ?? {};
    if (typeof name !== 'string' || !name) throw new AppError(400, 'name is required');
    return reply.status(201).send(await registerProduct(tenantId, name));
  });

  fastify.get('/api/v1/admin/tenants/:tenantId/products', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    assertTenantAccess(request, tenantId);
    const q = request.query as Record<string, string>;
    const active = q.active === 'true' ? true : q.active === 'false' ? false : undefined;
    return reply.send(await listProducts(tenantId, active));
  });

  fastify.get('/api/v1/admin/tenants/:tenantId/products/:productId', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertTenantAccess(request, tenantId);
    return reply.send(await getProduct(productId, tenantId));
  });

  fastify.put(
    '/api/v1/admin/tenants/:tenantId/products/:productId/rotate-secret',
    async (request, reply) => {
      const { tenantId, productId } = request.params as { tenantId: string; productId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');
      assertTenantAccess(request, tenantId);
      return reply.send(await rotateProductSecret(productId, tenantId));
    },
  );
};

export default adminProductRoutes;
