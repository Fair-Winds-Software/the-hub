// Authorized by HUB-77 — buildApp() factory; plugin registration order is load-bearing for all 37 downstream Epics
// Authorized by HUB-78 — loggerPlugin registered second; createServerOptions() replaces static serverOptions
// Authorized by HUB-79 — errorHandlerPlugin registered third; AppError + canonical {error:{code,message}} format
// Authorized by HUB-99 — rateLimitPlugin registered fourth; Redis-backed rate limiting with fail-open
// Authorized by HUB-98 — authPlugin registered fifth; service JWT issuance + authenticate decorator
// Authorized by HUB-112 — operatorAuthPlugin registered sixth; operator JWT issuance + authenticateOperator decorator
// Authorized by HUB-113 — corsPlugin registered first (locked E2 order); CORS_ORIGINS env-configurable
import Fastify from 'fastify';
import type { DestinationStream } from 'pino';
import { createServerOptions } from './server.js';
import { validateEnv } from './config/env.js';
import corsPlugin from './plugins/cors.js';
import loggerPlugin from './plugins/logger.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import authPlugin from './plugins/auth.js';
import operatorAuthPlugin from './plugins/operatorAuth.js';
import healthPlugin from './plugins/health.js';

export async function buildApp(dest?: DestinationStream) {
  validateEnv();

  const fastify = Fastify(createServerOptions(dest));

  // Locked E2 plugin registration order (HUB-113 finalises this chain):
  // 1. CORS plugin              — HUB-113 ✅
  // 2. Pino logger plugin       — HUB-78  ✅
  // 3. Error handler plugin     — HUB-79  ✅
  // 4. Rate-limit plugin        — HUB-99  ✅
  // 5. Service auth plugin      — HUB-98  ✅
  // 6. Operator auth plugin     — HUB-112 ✅
  // 7. Health routes            — HUB-77  ✅
  // 8. Business routes          — downstream Epics
  // 9. Operator routes          — downstream Epics
  await fastify.register(corsPlugin);
  await fastify.register(loggerPlugin);
  await fastify.register(errorHandlerPlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(authPlugin);
  await fastify.register(operatorAuthPlugin);
  await fastify.register(healthPlugin);

  return fastify;
}
