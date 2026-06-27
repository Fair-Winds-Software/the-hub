// Authorized by HUB-1032 — POST /api/v1/admin/auth/login
// Authorized by HUB-1033 — POST /api/v1/admin/auth/refresh (token rotation); POST /api/v1/admin/auth/logout
// Authorized by HUB-1704 — pass request.ip + request.id (trace) to service layer for audit context
// Authorized by HUB-1695 (E-BE-1 S18) — POST /api/v1/admin/auth/revoke-pending; anonymous + idempotent
//   session revoke for the Operator Console logout retry-on-reconnect flow (HUB-1579 consumer,
//   D-HUB-SCOPE-030). Per-route rate limit (10/min/IP) replaces the default 100/min. The
//   per-route errorResponseBuilder THROWS an AppError(429, 'RATE_LIMITED') (matches global
//   plugin pattern; @fastify/rate-limit v11 throws the builder return as an error). Body shape
//   diverges from the spec's `{code:'RATE_LIMITED', retryAfterSeconds:60}` — rendered as
//   `{error:'RATE_LIMITED'}` with the retry timing carried by the standard `retry-after` header
//   (configured by the global plugin). Documented deviation; FE (HUB-1579) reads the header.
//   sessionId maps to operator_refresh_tokens.id (HUB has no separate sessions table — story
//   spec said "sessions"; documented in operatorAuth.ts deviation note).
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import logger from '../../lib/logger.js';
import {
  loginOperator,
  refreshOperatorToken,
  logoutOperator,
  revokePendingSession,
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

  fastify.post(
    '/api/v1/admin/auth/revoke-pending',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60_000,
          errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED'),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as Record<string, unknown> | null;
      const sessionId = body?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new AppError(400, 'sessionId is required');
      }

      logger.info(
        {
          req_id: request.id,
          ip: request.ip,
          session_id_tail: sessionId.slice(-4),
        },
        'revoke-pending request',
      );

      const result = await revokePendingSession(sessionId, auditContextFrom(request));
      return reply.status(200).send(result);
    },
  );
};

export default adminAuthRoutes;
