// Authorized by HUB-1518 — GET /api/v1/audit; operator JWT auth; tenant scoping; cursor pagination; 90-day max range
// Authorized by HUB-46 FVL — M1: extract + forward actor_id and product_id query params
// Authorized by HUB-46 FVL — M2: super_admin tenant_id is optional (omit for cross-tenant queries)

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { queryAuditLog } from "../services/auditQueryService.js";
import { AppError } from "../errors/AppError.js";

interface OperatorClaims {
  operator_id: string;
  role: "super_admin" | "product_admin";
  tenant_id: string | null;
}

// operatorRbacHook is not used here: it enforces path-param tenant scoping which
// doesn't apply to this query-param-based endpoint. JWT is verified and
// request.operatorUser is populated, then scoping is enforced in the handler.
async function requireOperatorJwt(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    throw new AppError(401, "Unauthorized");
  const token = authHeader.slice(7);
  try {
    const claims = jwt.verify(
      token,
      process.env.OPERATOR_JWT_SECRET!,
    ) as OperatorClaims;
    request.operatorUser = {
      operator_id: claims.operator_id,
      role: claims.role,
      tenant_id: claims.tenant_id ?? null,
    };
  } catch {
    throw new AppError(401, "Unauthorized");
  }
}

const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/v1/audit",
    { preHandler: [requireOperatorJwt] },
    async (request, reply) => {
      const op = request.operatorUser!;
      const q = request.query as Record<string, string | undefined>;

      const from_str = q["from"];
      const to_str = q["to"];
      if (!from_str || !to_str)
        throw new AppError(400, "from and to are required");

      const from = new Date(from_str);
      const to = new Date(to_str);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        throw new AppError(400, "from and to must be valid ISO8601 dates");
      }

      let tenant_id: string | undefined;

      if (op.role === "product_admin") {
        const requested = q["tenant_id"];
        // product_admin may only query their own tenant — WHERE clause enforcement, not UI guard
        if (requested && requested !== op.tenant_id) {
          throw new AppError(403, "Forbidden");
        }
        if (!op.tenant_id) throw new AppError(403, "Forbidden");
        tenant_id = op.tenant_id;
      } else {
        // super_admin/operator: tenant_id is optional — omit to query across all tenants (M2)
        tenant_id = q["tenant_id"] ?? undefined;
      }

      const rawLimit = parseInt(q["limit"] ?? "50", 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit;

      const result = await queryAuditLog({
        tenant_id,
        product_id: q["product_id"],
        actor_id: q["actor_id"],
        table_name: q["table_name"],
        operation: q["operation"],
        from,
        to,
        limit,
        cursor: q["cursor"],
      });

      return reply.status(200).send(result);
    },
  );
};

export default fp(auditRoutes, { name: "audit-routes" });
