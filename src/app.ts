// Authorized by HUB-77 — buildApp() factory; plugin registration order is load-bearing for all 37 downstream Epics
// Authorized by HUB-78 — loggerPlugin registered first; createServerOptions() replaces static serverOptions
// Authorized by HUB-79 — errorHandlerPlugin registered second; AppError + canonical {error:{code,message}} format
import Fastify from 'fastify';
import type { DestinationStream } from 'pino';
import { createServerOptions } from './server.js';
import { validateEnv } from './config/env.js';
import loggerPlugin from './plugins/logger.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import healthPlugin from './plugins/health.js';

export async function buildApp(dest?: DestinationStream) {
  validateEnv();

  const fastify = Fastify(createServerOptions(dest));

  // Plugin registration order (each story in E2 inserts at its assigned slot):
  // 1. Pino logger plugin         — HUB-78  ✅
  // 2. Error handler plugin        — HUB-79  ✅
  // 3. Rate-limit plugin           — HUB-99
  // 4. Service auth plugin         — HUB-98
  // 5. Operator auth plugin        — HUB-112
  // 6. CORS plugin                 — HUB-113
  // 7. Health routes (unprotected) — HUB-77
  // 8. Business routes (downstream Epics)
  await fastify.register(loggerPlugin);
  await fastify.register(errorHandlerPlugin);
  await fastify.register(healthPlugin);

  return fastify;
}
