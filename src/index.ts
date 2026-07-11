// Authorized by HUB-77 — HUB service entry point; SIGTERM graceful shutdown
// Authorized by HUB-174 — Stripe env validation before server accepts requests
// Authorized by HUB-237 — validateObservabilityEnv() called before buildApp() so invalid log config is caught at startup
// Authorized by HUB-1087 — seedInternalTenant called at startup; idempotent; runs after buildApp
// Authorized by HUB-1781 (S8 of HUB-1773): replaced startup validateStripeEnv() with
// initStripeRegistry(). Registry decides live vs mock mode based on the operator-set
// setting; live-mode credential fail-fast lives inside initStripeRegistry now so dev/mock
// startups don't need Stripe env vars set.
import 'dotenv/config';
import { buildApp } from './app.js';
import { closePool, getPool } from './db/pool.js';
import { closeRedis } from './redis/client.js';
import { initStripeRegistry } from './stripe/registry.js';
import { validateObservabilityEnv } from './logging/env.js';
import logger from './lib/logger.js';
import { seedInternalTenant } from './seeds/internalTenant.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  validateObservabilityEnv();

  const fastify = await buildApp();
  await seedInternalTenant(getPool());
  await initStripeRegistry();

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
