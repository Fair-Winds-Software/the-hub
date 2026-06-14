// Authorized by HUB-230 — GET /health route; probe-backed aggregated health check; no auth or rate limit
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { runHealthChecks, type HealthCheckResult } from '../health/probes.js';

export function deriveStatus(result: HealthCheckResult): 'ok' | 'degraded' {
  return Object.values(result).every((v) => v === 'ok' || v === 'disabled')
    ? 'ok'
    : 'degraded';
}

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/health',
    { config: { rateLimit: false } },
    async (_request, reply) => {
      const checks = await runHealthChecks();
      const status = deriveStatus(checks);
      return reply.status(status === 'ok' ? 200 : 503).send({ status, checks });
    },
  );
};

export default fp(healthRoutes, { name: 'health-routes' });
