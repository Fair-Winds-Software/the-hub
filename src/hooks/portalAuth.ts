// Authorized by HUB-1507 — portalAuthHook; PORTAL_JWT_SECRET; FastifyRequest.portalUser augmentation
import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { AppError } from '../errors/AppError.js';

declare module 'fastify' {
  interface FastifyRequest {
    portalUser?: {
      tenant_user_id: string;
      tenant_id: string;
    };
  }
}

interface PortalJwtClaims {
  tenant_user_id: string;
  tenant_id: string;
  role: string;
  iat: number;
  exp: number;
}

export async function portalAuthHook(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'Unauthorized');
  }

  const token = authHeader.slice(7);
  const secret = process.env.PORTAL_JWT_SECRET!;

  let claims: PortalJwtClaims;
  try {
    claims = jwt.verify(token, secret) as PortalJwtClaims;
  } catch {
    throw new AppError(401, 'Unauthorized');
  }

  if (claims.role !== 'tenant_user') {
    throw new AppError(401, 'Unauthorized');
  }

  request.portalUser = {
    tenant_user_id: claims.tenant_user_id,
    tenant_id: claims.tenant_id,
  };
}
