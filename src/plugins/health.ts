// Authorized by HUB-77 — /health/ready liveness probe; pg + Redis reachability; registered before auth
// GET /health moved to src/routes/health.ts (HUB-230)
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { getRedisClient } from '../redis/client.js';

const healthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health/ready', async (_request, reply) => {
    const timeout = (ms: number): Promise<never> =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

    try {
      await Promise.all([
        Promise.race([getPool().query('SELECT 1'), timeout(2000)]),
        Promise.race([getRedisClient().ping(), timeout(2000)]),
      ]);
      return reply.status(200).send({ status: 'ok' });
    } catch {
      return reply.status(503).send({ status: 'degraded' });
    }
  });
};

export default healthPlugin;
