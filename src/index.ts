// Authorized by HUB-77 — HUB service entry point; SIGTERM graceful shutdown
// Authorized by HUB-174 — Stripe env validation before server accepts requests
// Authorized by HUB-237 — validateObservabilityEnv() called before buildApp() so invalid log config is caught at startup
import 'dotenv/config';
import { buildApp } from './app.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './redis/client.js';
import { validateStripeEnv } from './stripe/client.js';
import { validateObservabilityEnv } from './logging/env.js';
import logger from './lib/logger.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  validateObservabilityEnv();
  validateStripeEnv();

  const fastify = await buildApp();

  const shutdown = async () => {
    logger.info('SIGTERM received — beginning graceful shutdown');
    try {
      await Promise.race([
        fastify.close(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('shutdown timeout after 10s')), 10_000)
        ),
      ]);
    } catch (err) {
      logger.error({ err }, 'graceful shutdown error');
    } finally {
      await closePool();
      await closeRedis();
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => {
    shutdown().catch(() => process.exit(1));
  });

  await fastify.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT }, 'HUB service started');
}

main().catch((err) => {
  logger.error({ err }, 'startup failed');
  process.exit(1);
});
