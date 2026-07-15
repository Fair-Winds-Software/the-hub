// Authorized by HUB-1818 (S1 of HUB-1787) — POST /api/v1/admin/onboarding/register.
// super_admin only. Delegates the whole flow to onboardingService.registerProduct so the
// route stays a thin adapter: request validation → service call → 201 response with the
// plaintext client_secret one-time reveal.
//
// Authorized by HUB-1819 (S2 of HUB-1787) — added rotation + revocation:
//   POST /api/v1/admin/onboarding/:productId/rotate-credential
//   POST /api/v1/admin/onboarding/:productId/revoke
// Both super_admin only; both accept an optional { reason } body captured in audit.
//
// Authorized by HUB-1821 (S4 of HUB-1787) — added prompt generation:
//   POST /api/v1/admin/onboarding/:productId/prompt
// Body carries the plaintext client_id + client_secret (which the operator has
// in-hand from S1 register or S2 rotate). Deferred to POST (not GET as originally
// authored) so secrets don't land in access logs. super_admin only.
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { registerProduct, rotateCredential, revokeProduct } from '../../services/onboardingService.js';
import { buildOnboardingPrompt } from '../../services/onboardingPromptService.js';

interface OperatorAuth {
  operator_id?: string;
  role?: string;
  tenant_id?: string | null;
}

function operatorFromRequest(req: FastifyRequest): OperatorAuth {
  return (req as unknown as { operatorUser?: OperatorAuth }).operatorUser ?? {};
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

  // ── HUB-1821 (S4 of HUB-1787) — build Claude Code prompt ──────────────────
  fastify.post<{
    Params: { productId: string };
    Body: { client_id?: string; client_secret?: string; hub_url?: string };
  }>('/api/v1/admin/onboarding/:productId/prompt', async (req, reply) => {
    const op = operatorFromRequest(req);
    if (op.role !== 'super_admin') {
      throw new AppError(403, 'Prompt generation requires super_admin');
    }
    const body = (req.body ?? {}) as {
      client_id?: unknown;
      client_secret?: unknown;
      hub_url?: unknown;
    };
    if (typeof body.client_id !== 'string' || body.client_id.length === 0) {
      throw new AppError(400, 'client_id (string) is required in the body');
    }
    if (typeof body.client_secret !== 'string' || body.client_secret.length === 0) {
      throw new AppError(400, 'client_secret (string) is required in the body');
    }
    if (body.hub_url !== undefined && typeof body.hub_url !== 'string') {
      throw new AppError(400, 'hub_url must be a string when provided');
    }
    const result = await buildOnboardingPrompt({
      product_id: req.params.productId,
      client_id: body.client_id,
      client_secret: body.client_secret,
      hub_url: body.hub_url,
    });
    return reply.status(200).send(result);
  });

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
