// Authorized by HUB-1517 — auditContext Fastify plugin; decorates request with actor context; buildAuditContext helper

import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

export interface AuditContext {
  actor_id: string | null;
  actor_type: "operator" | "service" | "system" | null;
  ip_address: string | null;
  trace_id: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auditContext: AuditContext;
  }
}

// Plugin wrapper ensures the module augmentation and buildAuditContext export
// are scoped correctly via fp(); no decorator needed since routes use buildAuditContext() directly.
const auditContextPlugin: FastifyPluginAsync = async (_fastify) => {};

// Builds actor context from the current auth state on the request.
// Must be called after auth preHandlers have run (operatorRbacHook or authenticate).
export function buildAuditContext(request: FastifyRequest): AuditContext {
  const bindings =
    (
      request.log as { bindings?: () => Record<string, unknown> }
    ).bindings?.() ?? {};
  const trace_id =
    typeof bindings["trace_id"] === "string" ? bindings["trace_id"] : null;

  if (request.operatorUser) {
    return {
      actor_id: request.operatorUser.operator_id,
      actor_type: "operator",
      ip_address: request.ip ?? null,
      trace_id,
    };
  }

  if (request.tenant_id) {
    return {
      actor_id: request.product_id ?? null,
      actor_type: "service",
      ip_address: request.ip ?? null,
      trace_id,
    };
  }

  return {
    actor_id: null,
    actor_type: "system",
    ip_address: request.ip ?? null,
    trace_id,
  };
}

export default fp(auditContextPlugin, { name: "audit-context" });
