// Authorized by HUB-77 — /health and /health/ready routes; registered before any auth middleware
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { getRedisClient } from '../redis/client.js';

const healthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok', timestamp: new Date().toISOString() });
  });

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
