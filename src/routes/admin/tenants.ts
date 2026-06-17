// Authorized by HUB-1086 — tenant CRUD routes; super_admin full; tenant_admin read-own
// Authorized by HUB-1127 — DELETE cascades products; returns products_deactivated count
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  createTenant,
  listTenants,
  getTenant,
  updateTenant,
  deactivateTenant,
} from '../../services/tenants.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

const adminTenantRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/admin/tenants', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const body = request.body as Record<string, unknown> | null;
    const { name, tenant_type } = body ?? {};
    if (typeof name !== 'string' || !name) throw new AppError(400, 'name is required');
    if (tenant_type !== 'external' && tenant_type !== 'internal') {
      throw new AppError(400, 'tenant_type must be "external" or "internal"');
    }
    return reply.status(201).send(await createTenant({ name, tenant_type }));
  });

  fastify.get('/api/v1/admin/tenants', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const q = request.query as Record<string, string>;
    const active = q.active === 'true' ? true : q.active === 'false' ? false : undefined;
    return reply.send(await listTenants({ active, tenant_type: q.tenant_type }));
  });

  fastify.get('/api/v1/admin/tenants/:tenantId', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    const op = request.operatorUser!;
    if (op.role === 'tenant_admin' && op.tenant_id !== tenantId) {
      throw new AppError(403, 'Forbidden');
    }
    return reply.send(await getTenant(tenantId));
  });

  fastify.put('/api/v1/admin/tenants/:tenantId', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    const body = request.body as Record<string, unknown> | null;
    return reply.send(
      await updateTenant(tenantId, {
        name: typeof body?.name === 'string' ? body.name : undefined,
        active: typeof body?.active === 'boolean' ? body.active : undefined,
      }),
    );
  });

  fastify.delete('/api/v1/admin/tenants/:tenantId', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    const result = await deactivateTenant(tenantId);
    return reply.send({ tenant_id: tenantId, active: false, ...result });
  });
};

export default adminTenantRoutes;
