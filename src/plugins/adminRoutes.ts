// Authorized by HUB-1034 — adminRoutes plugin; auth sub-routes public; protected sub-routes behind operatorRbacHook
// Authorized by HUB-1086 — adminTenantRoutes registered in RBAC-protected scope
// Authorized by HUB-1103 — adminProductRoutes registered in RBAC-protected scope
// Authorized by HUB-1494 — adminBillingRoutes registered in RBAC-protected scope (pricing model GET/PUT)
// Authorized by HUB-1495 — adminBillingRoutes: invoice list + detail (D-005 per-product scope)
// Authorized by HUB-1496 — adminBillingRoutes: product freeze/unfreeze (D-006 per-product scope)
// Authorized by HUB-1497 — adminBillingRoutes: Stripe customer link (super_admin only)
// Authorized by HUB-1500 — adminNotificationsRoutes: alert summary endpoint
// Authorized by HUB-1501 — adminNotificationsRoutes: alert ack/resolve/list RBAC delegation
// Authorized by HUB-1502 — adminNotificationsRoutes: notification channel CRUD
// Authorized by HUB-1503 — adminNotificationsRoutes: escalation rule CRUD with 2-tier cap
// Authorized by HUB-1504 — adminNotificationsRoutes: workflow hook CRUD with hmac_secret masking
// Authorized by HUB-1021 — adminComplianceRoutes: control registry CRUD + product registration + burn-in + bindings
// Authorized by HUB-1057 — adminComplianceDashboardRoutes: overview, product detail, posture trend
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { operatorRbacHook } from '../hooks/operatorRbac.js';
import adminAuthRoutes from '../routes/admin/auth.js';
import adminOperatorRoutes from '../routes/admin/operators.js';
import adminSettingsRoutes from '../routes/admin/settings.js';
import adminTenantRoutes from '../routes/admin/tenants.js';
import adminProductRoutes from '../routes/admin/products.js';
import adminBillingRoutes from '../routes/admin/billing.js';
import adminNotificationsRoutes from '../routes/admin/notifications.js';
import adminComplianceRoutes from '../routes/admin/compliance.js';
import adminComplianceDashboardRoutes from '../routes/admin/complianceDashboard.js';

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
    await scope.register(adminBillingRoutes);
    await scope.register(adminNotificationsRoutes);
    await scope.register(adminComplianceRoutes);
    await scope.register(adminComplianceDashboardRoutes);
  });
};

export default fp(adminRoutesPlugin, { name: 'admin-routes' });
