// Authorized by HUB-1818 (S1 of HUB-1787) — POST /api/v1/admin/onboarding/register.
// super_admin only. Delegates the whole flow to onboardingService.registerProduct so the
// route stays a thin adapter: request validation → service call → 201 response with the
// plaintext client_secret one-time reveal.
//
// Authorized by HUB-1819 (S2 of HUB-1787) — added rotation + revocation:
//   POST /api/v1/admin/onboarding/:productId/rotate-credential
//   POST /api/v1/admin/onboarding/:productId/revoke
// Both super_admin only; both accept an optional { reason } body captured in audit.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { registerProduct, rotateCredential, revokeProduct } from '../../services/onboardingService.js';

interface OperatorAuth {
  operator_id?: string;
  role?: string;
  tenant_id?: string | null;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  return (req as unknown as { operator?: OperatorAuth }).operator ?? {};
}

interface RegisterBody {
  tenant_id: string;
  name: string;
  slug: string;
  product_type?: string;
}

const adminOnboardingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: RegisterBody }>(
    '/api/v1/admin/onboarding/register',
    async (req, reply) => {
      const op = operatorFromRequest(req);
      if (op.role !== 'super_admin') {
        throw new AppError(403, 'Onboarding registration requires super_admin');
      }

      const body = (req.body ?? {}) as Partial<RegisterBody>;
      if (typeof body.tenant_id !== 'string') throw new AppError(400, 'tenant_id (uuid) is required');
      if (typeof body.name !== 'string') throw new AppError(400, 'name (string) is required');
      if (typeof body.slug !== 'string') throw new AppError(400, 'slug (string) is required');
      if (body.product_type !== undefined && typeof body.product_type !== 'string') {
        throw new AppError(400, 'product_type must be a string when provided');
      }

      const result = await registerProduct({
        tenant_id: body.tenant_id,
        name: body.name,
        slug: body.slug,
        product_type: body.product_type,
        actor_operator_id: op.operator_id ?? 'unknown-operator',
        actor_ip: req.ip ?? null,
        actor_trace_id: (req.id as string | undefined) ?? null,
      });

      return reply.status(201).send(result);
    },
  );

  // ── HUB-1819 (S2 of HUB-1787) — rotate credential ─────────────────────────
  fastify.post<{ Params: { productId: string }; Body: { reason?: string } }>(
    '/api/v1/admin/onboarding/:productId/rotate-credential',
    async (req, reply) => {
      const op = operatorFromRequest(req);
      if (op.role !== 'super_admin') {
        throw new AppError(403, 'Credential rotation requires super_admin');
      }
      const body = (req.body ?? {}) as { reason?: unknown };
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        throw new AppError(400, 'reason must be a string when provided');
      }
      const result = await rotateCredential({
        product_id: req.params.productId,
        actor_operator_id: op.operator_id ?? 'unknown-operator',
        actor_ip: req.ip ?? null,
        actor_trace_id: (req.id as string | undefined) ?? null,
        reason: body.reason,
      });
      return reply.status(200).send(result);
    },
  );

  // ── HUB-1819 (S2 of HUB-1787) — revoke product ────────────────────────────
  fastify.post<{ Params: { productId: string }; Body: { reason?: string } }>(
    '/api/v1/admin/onboarding/:productId/revoke',
    async (req, reply) => {
      const op = operatorFromRequest(req);
      if (op.role !== 'super_admin') {
        throw new AppError(403, 'Revocation requires super_admin');
      }
      const body = (req.body ?? {}) as { reason?: unknown };
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        throw new AppError(400, 'reason must be a string when provided');
      }
      const result = await revokeProduct({
        product_id: req.params.productId,
        actor_operator_id: op.operator_id ?? 'unknown-operator',
        actor_ip: req.ip ?? null,
        actor_trace_id: (req.id as string | undefined) ?? null,
        reason: body.reason,
      });
      return reply.status(200).send(result);
    },
  );
};

export default adminOnboardingRoutes;
