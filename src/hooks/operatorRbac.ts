// Authorized by HUB-1034 — operatorRbacHook; super_admin unrestricted; tenant_admin scoped to tenant_id
// Authorized by HUB-4.1 L2 — Red Team M1/L3: explicit exp check so non-expiring crafted tokens are rejected
import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { AppError } from '../errors/AppError.js';

declare module 'fastify' {
  interface FastifyRequest {
    operatorUser?: {
      operator_id: string;
      role: 'super_admin' | 'tenant_admin';
      tenant_id: string | null;
    };
  }
}

interface OperatorJwtClaims {
  operator_id: string;
  role: 'super_admin' | 'tenant_admin';
  tenant_id: string | null;
  iat: number;
  exp: number;
}

export async function operatorRbacHook(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'Unauthorized');
  }

  const token = authHeader.slice(7);
  const secret = process.env.OPERATOR_JWT_SECRET!;

  let claims: OperatorJwtClaims;
  try {
    claims = jwt.verify(token, secret) as OperatorJwtClaims;
    if (!claims.exp) throw new AppError(401, 'Unauthorized');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, 'Unauthorized');
  }

  request.operatorUser = {
    operator_id: claims.operator_id,
    role: claims.role,
    tenant_id: claims.tenant_id ?? null,
  };

  if (claims.role === 'super_admin') return;

  // tenant_admin: derive resource tenant_id from route — path param takes precedence over body
  const params = request.params as Record<string, unknown>;
  const body = request.body as Record<string, unknown> | null;

  const resourceTenantId =
    (typeof params.tenantId === 'string' ? params.tenantId : undefined) ??
    (body !== null && typeof body?.tenant_id === 'string' ? body.tenant_id : undefined);

  if (!resourceTenantId || resourceTenantId !== claims.tenant_id) {
    throw new AppError(403, 'Forbidden');
  }
}
