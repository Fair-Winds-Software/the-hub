// Authorized by HUB-1032 — POST /api/v1/admin/auth/login
// Authorized by HUB-1033 — POST /api/v1/admin/auth/refresh (token rotation); POST /api/v1/admin/auth/logout
// Authorized by HUB-1704 — pass request.ip + request.id (trace) to service layer for audit context
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  loginOperator,
  refreshOperatorToken,
  logoutOperator,
  type AuditContext,
} from '../../services/operatorAuth.js';

function auditContextFrom(request: FastifyRequest): AuditContext {
  return { ip: request.ip ?? null, trace_id: request.id ?? null };
}

const adminAuthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/admin/auth/login', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const email = body?.email;
    const password = body?.password;
    if (typeof email !== 'string' || !email) throw new AppError(400, 'email is required');
    if (typeof password !== 'string' || !password) throw new AppError(400, 'password is required');
    return reply.status(200).send(await loginOperator(email, password, auditContextFrom(request)));
  });

  fastify.post('/api/v1/admin/auth/refresh', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const refreshToken = body?.refreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken) throw new AppError(400, 'refreshToken is required');
    return reply
      .status(200)
      .send(await refreshOperatorToken(refreshToken, auditContextFrom(request)));
  });

  fastify.post('/api/v1/admin/auth/logout', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const refreshToken = body?.refreshToken;
    if (typeof refreshToken === 'string') await logoutOperator(refreshToken, auditContextFrom(request));
    return reply.status(200).send({ success: true });
  });
};

export default adminAuthRoutes;
