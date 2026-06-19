// Authorized by HUB-230 — GET /health route; probe-backed aggregated health check; no auth or rate limit
// Authorized by HUB-1514 — GET /ready route; pg+redis critical probes; 503 with failing[] array
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { runHealthChecks, type HealthCheckResult } from "../health/probes.js";

export function deriveStatus(result: HealthCheckResult): "ok" | "degraded" {
  return Object.values(result).every(
    (v) => v.status === "ok" || v.status === "disabled",
  )
    ? "ok"
    : "degraded";
}

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/health",
    { config: { rateLimit: false } },
    async (_request, reply) => {
      const checks = await runHealthChecks();
      const status = deriveStatus(checks);
      return reply.status(status === "ok" ? 200 : 503).send({ status, checks });
    },
  );

  fastify.get(
    "/ready",
    { config: { rateLimit: false } },
    async (_request, reply) => {
      const checks = await runHealthChecks();
      const failing: string[] = [];
      if (checks.pg.status !== "ok") failing.push("pg");
      if (checks.redis.status !== "ok") failing.push("redis");
      if (failing.length > 0) {
        return reply.status(503).send({ status: "degraded", failing });
      }
      return reply.status(200).send({ status: "ok" });
    },
  );
};

export default fp(healthRoutes, { name: "health-routes" });
