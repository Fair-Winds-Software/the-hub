// Authorized by HUB-1032 — POST /api/v1/admin/auth/login; bcrypt verify; operator JWT; refresh token
// Authorized by HUB-1033 — POST /api/v1/admin/auth/refresh (token rotation); POST /api/v1/admin/auth/logout
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { loginOperator, refreshOperatorToken, logoutOperator } from '../../services/operatorAuth.js';

const adminAuthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/admin/auth/login', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const email = body?.email;
    const password = body?.password;
    if (typeof email !== 'string' || !email) throw new AppError(400, 'email is required');
    if (typeof password !== 'string' || !password) throw new AppError(400, 'password is required');
    return reply.status(200).send(await loginOperator(email, password));
  });

  fastify.post('/api/v1/admin/auth/refresh', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const refreshToken = body?.refreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken) throw new AppError(400, 'refreshToken is required');
    return reply.status(200).send(await refreshOperatorToken(refreshToken));
  });

  fastify.post('/api/v1/admin/auth/logout', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const refreshToken = body?.refreshToken;
    if (typeof refreshToken === 'string') await logoutOperator(refreshToken);
    return reply.status(200).send({ success: true });
  });
};

export default adminAuthRoutes;
