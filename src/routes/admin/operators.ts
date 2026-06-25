// Authorized by HUB-1058 — POST/GET/PUT/DELETE /api/v1/admin/operators; super_admin only; soft-delete
// Authorized by HUB-1059 — PUT /api/v1/admin/operators/:id/role; tenant validation; self-change guard
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  createOperator,
  listOperators,
  getOperator,
  updateOperator,
  deactivateOperator,
  assignOperatorRole,
} from '../../services/operators.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

const adminOperatorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/admin/operators', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const body = request.body as Record<string, unknown> | null;
    const operator = await createOperator({
      email: body?.email as string,
      password: body?.password as string,
      role: body?.role as 'super_admin' | 'product_admin',
      tenant_id: body?.tenant_id as string | null | undefined,
    });
    return reply.status(201).send(operator);
  });

  fastify.get('/api/v1/admin/operators', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const query = request.query as Record<string, string>;
    const active =
      query.active === 'true' ? true : query.active === 'false' ? false : undefined;
    return reply.send(await listOperators(active));
  });

  fastify.get('/api/v1/admin/operators/:id', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const { id } = request.params as { id: string };
    assertUUID(id, 'id');
    return reply.send(await getOperator(id));
  });

  fastify.put('/api/v1/admin/operators/:id', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const { id } = request.params as { id: string };
    assertUUID(id, 'id');
    const body = request.body as Record<string, unknown> | null;
    return reply.send(
      await updateOperator(id, {
        email: body?.email as string | undefined,
        active: body?.active as boolean | undefined,
      }),
    );
  });

  fastify.delete('/api/v1/admin/operators/:id', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const { id } = request.params as { id: string };
    assertUUID(id, 'id');
    await deactivateOperator(id, request.operatorUser.operator_id);
    return reply.send({ success: true });
  });

  fastify.put('/api/v1/admin/operators/:id/role', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
    const { id } = request.params as { id: string };
    assertUUID(id, 'id');
    const body = request.body as Record<string, unknown> | null;
    return reply.send(
      await assignOperatorRole(
        id,
        body?.role as 'super_admin' | 'product_admin',
        body?.tenant_id as string | null | undefined,
        request.operatorUser.operator_id,
      ),
    );
  });
};

export default adminOperatorRoutes;
