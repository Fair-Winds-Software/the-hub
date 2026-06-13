// Authorized by HUB-77 — buildApp() factory; plugin registration order is load-bearing for all 37 downstream Epics
import Fastify from 'fastify';
import { serverOptions } from './server.js';
import { validateEnv } from './config/env.js';
import healthPlugin from './plugins/health.js';

export async function buildApp() {
  validateEnv();

  const fastify = Fastify(serverOptions);

  // Plugin registration order (each story in E2 inserts at its assigned slot):
  // 1. Pino logger plugin         — HUB-78
  // 2. Error handler plugin        — HUB-79
  // 3. Rate-limit plugin           — HUB-99
  // 4. Service auth plugin         — HUB-98
  // 5. Operator auth plugin        — HUB-112
  // 6. CORS plugin                 — HUB-113
  // 7. Health routes (unprotected) — this story
  // 8. Business routes (downstream Epics)
  await fastify.register(healthPlugin);

  return fastify;
}
