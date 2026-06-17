// Authorized by HUB-1034 — adminRoutes plugin; auth sub-routes public; protected sub-routes behind operatorRbacHook
// Authorized by HUB-1086 — adminTenantRoutes registered in RBAC-protected scope
// Authorized by HUB-1103 — adminProductRoutes registered in RBAC-protected scope
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { operatorRbacHook } from '../hooks/operatorRbac.js';
import adminAuthRoutes from '../routes/admin/auth.js';
import adminOperatorRoutes from '../routes/admin/operators.js';
import adminSettingsRoutes from '../routes/admin/settings.js';
import adminTenantRoutes from '../routes/admin/tenants.js';
import adminProductRoutes from '../routes/admin/products.js';

const adminRoutesPlugin: FastifyPluginAsync = async (fastify) => {
  // Auth routes are public — registered without the RBAC onRequest hook
  await fastify.register(adminAuthRoutes);

  // All other admin routes are protected by the RBAC hook.
  // Scoped inner plugin (no fp()) so the hook stays within this scope.
  await fastify.register(async (scope) => {
    scope.addHook('onRequest', operatorRbacHook);
    await scope.register(adminOperatorRoutes);
    await scope.register(adminSettingsRoutes);
    await scope.register(adminTenantRoutes);
    await scope.register(adminProductRoutes);
  });
};

export default fp(adminRoutesPlugin, { name: 'admin-routes' });
