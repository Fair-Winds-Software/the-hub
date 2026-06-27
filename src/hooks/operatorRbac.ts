// Authorized by HUB-1034 — operatorRbacHook; super_admin unrestricted; product_admin scoped to tenant_id
// Authorized by HUB-4.1 L2 — Red Team M1/L3: explicit exp check so non-expiring crafted tokens are rejected
// Authorized by HUB-1588 — backward-compat window for CR-4 role rename: accept legacy
//   `tenant_admin` JWT claims when settings.role_rename_compat_window_enabled = true, // tenant-admin-rename:historical
//   normalize to `product_admin`, and log telemetry. Fail-secure on settings fetch error.
// Authorized by HUB-1697 (E-BE-1 S20) — extend resourceTenantId derivation to also read
//   request.query.tenant_id. Closes a latent gap where GET routes that scope by query string
//   (e.g., /admin/console/audit-log) always 403'd for product_admin because the hook only
//   consulted params + body. No existing admin GET is currently used by product_admin with
//   query-based tenant scoping; this unblocks HUB-1697's RBAC ACs without behavioral change
//   to existing callers.
import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { AppError } from '../errors/AppError.js';
import { getSetting } from '../services/adminSettings.js';
import logger from '../lib/logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    operatorUser?: {
      operator_id: string;
      role: 'super_admin' | 'product_admin';
      tenant_id: string | null;
    };
  }
}

/**
 * HUB-1588: widened input claim type covers the compat window. The legacy `tenant_admin` // tenant-admin-rename:historical
 * is accepted at the boundary, then normalized to `product_admin` before downstream code
 * runs — `request.operatorUser.role` is always one of the canonical two values.
 */
type ClaimRole = 'super_admin' | 'product_admin' | 'tenant_admin'; // tenant-admin-rename:historical

interface OperatorJwtClaims {
  operator_id: string;
  role: ClaimRole;
  tenant_id: string | null;
  iat: number;
  exp: number;
}

const COMPAT_FLAG_KEY = 'role_rename_compat_window_enabled';

/**
 * Read the compat window flag from settings (Redis-first per HUB-1060). Fail-secure: if
 * the read throws or the value is anything other than boolean true, return false. This
 * keeps the legacy claim path closed by default — only an explicit `true` in settings
 * opens the window.
 */
async function compatWindowEnabled(): Promise<boolean> {
  try {
    const v = await getSetting(COMPAT_FLAG_KEY);
    return v === true;
  } catch {
    return false;
  }
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

  // HUB-1588: normalize the claim role through the compat window. Legacy `tenant_admin` // tenant-admin-rename:historical
  // is accepted iff settings.role_rename_compat_window_enabled = true; otherwise 403.
  let normalizedRole: 'super_admin' | 'product_admin';
  if (claims.role === 'super_admin' || claims.role === 'product_admin') {
    normalizedRole = claims.role;
  } else if (claims.role === 'tenant_admin') { // tenant-admin-rename:historical
    const compatOk = await compatWindowEnabled();
    if (!compatOk) {
      throw new AppError(403, 'Forbidden');
    }
    logger.info(
      {
        event: 'jwt.legacy_claim_accepted',
        operator_id: claims.operator_id,
        tenant_id: claims.tenant_id,
      },
      'legacy tenant_admin JWT claim accepted during compat window', // tenant-admin-rename:historical
    );
    normalizedRole = 'product_admin';
  } else {
    // Unknown role string — never happened pre-rename either, but defensively reject.
    throw new AppError(401, 'Unauthorized');
  }

  request.operatorUser = {
    operator_id: claims.operator_id,
    role: normalizedRole,
    tenant_id: claims.tenant_id ?? null,
  };

  if (normalizedRole === 'super_admin') return;

  // product_admin: derive resource tenant_id from route — precedence: path param → body → query
  const params = request.params as Record<string, unknown>;
  const body = request.body as Record<string, unknown> | null;
  const query = request.query as Record<string, unknown> | undefined;

  const resourceTenantId =
    (typeof params.tenantId === 'string' ? params.tenantId : undefined) ??
    (body !== null && typeof body?.tenant_id === 'string' ? body.tenant_id : undefined) ??
    (query !== undefined && typeof query.tenant_id === 'string' ? query.tenant_id : undefined);

  if (!resourceTenantId || resourceTenantId !== claims.tenant_id) {
    throw new AppError(403, 'Forbidden');
  }
}
