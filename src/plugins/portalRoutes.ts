// Authorized by HUB-1507 — portalAuthHook registered as onRequest in protected scope
// Authorized by HUB-1508 — portalAuthRoutes: login endpoint (public)
// Authorized by HUB-1509 — portalDataRoutes: usage, invoices, notifications, profile
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { portalAuthHook } from '../hooks/portalAuth.js';
import portalAuthRoutes from '../routes/portal/auth.js';
import portalDataRoutes from '../routes/portal/index.js';

const portalRoutesPlugin: FastifyPluginAsync = async (fastify) => {
  // Login is public — registered without the portal auth hook
  await fastify.register(portalAuthRoutes);

  // All data routes are protected by the portal auth hook.
  // Scoped inner plugin (no fp()) so the hook stays within this scope.
  await fastify.register(async (scope) => {
    scope.addHook('onRequest', portalAuthHook);
    await scope.register(portalDataRoutes);
  });
};

export default fp(portalRoutesPlugin, { name: 'portal-routes' });
