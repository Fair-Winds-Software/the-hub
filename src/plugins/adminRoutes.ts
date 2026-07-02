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
// Authorized by HUB-1098 — adminComplianceAlertsRoutes: alert_rules GET/PUT
// Authorized by HUB-1102 — adminComplianceAlertsRoutes: notification list, acknowledge, acknowledge-all
// Authorized by HUB-1365 — adminComplianceAlertsRoutes: in-app notification center
// Authorized by HUB-1377 — adminComplianceExportRoutes: evidence query endpoint
// Authorized by HUB-1380 — adminComplianceExportRoutes: export job creation + bundle generation
// Authorized by HUB-1382 — adminComplianceExportRoutes: job status + ZIP download endpoints
// Authorized by HUB-1142 — adminAdvisorRoutes: run advisor endpoint
// Authorized by HUB-1143 — adminAdvisorRoutes: latest recommendation endpoint
// Authorized by HUB-1144 — adminAdvisorRoutes: record outcome endpoint
// Authorized by HUB-1148 — adminAdvisorRoutes: billing-summary, audit-note, history endpoints
// Authorized by HUB-1149 — adminAdvisorRoutes: enhanced portfolio summary + CSV export
// Authorized by HUB-1146 — adminOperatorConsoleRoutes: pricing overview endpoint
// Authorized by HUB-1147 — adminOperatorConsoleRoutes: tenant list, plan assignment, discounts, overrides, audit log
// Authorized by HUB-1594 (E-BE-1 S11, CR-1) — adminIntegrationRoutes: Jira ticket counts + admin recovery
// Authorized by HUB-1651 (E-FE-5 S1) — adminPlansRoutes: plans CRUD (list/create/update/soft-archive)
// Authorized by HUB-1652 (E-FE-5 S2) — adminAddOnsRoutes: add-ons CRUD (list/create/update/soft-archive)
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
import adminComplianceAlertsRoutes from '../routes/admin/complianceAlerts.js';
import adminComplianceExportRoutes from '../routes/admin/complianceExport.js';
import adminAdvisorRoutes from '../routes/admin/advisor.js';
import adminOperatorConsoleRoutes from '../routes/admin/operatorConsole.js';
import adminIntegrationRoutes from '../routes/admin/integrations.js';
import adminSdkVersionsRoutes from '../routes/admin/sdkVersions.js';
import adminPlansRoutes from '../routes/admin/plans.js';
import adminAddOnsRoutes from '../routes/admin/addons.js';

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
    await scope.register(adminComplianceAlertsRoutes);
    await scope.register(adminComplianceExportRoutes);
    await scope.register(adminAdvisorRoutes);
    await scope.register(adminOperatorConsoleRoutes);
    await scope.register(adminIntegrationRoutes);
    // HUB-1698 (E-BE-1 S21): SDK version analytics endpoints (super_admin-only inline check)
    await scope.register(adminSdkVersionsRoutes);
    // HUB-1651 (E-FE-5 S1): Plans CRUD (list / create / update / soft-archive)
    await scope.register(adminPlansRoutes);
    // HUB-1652 (E-FE-5 S2): Add-ons CRUD (list / create / update / soft-archive)
    await scope.register(adminAddOnsRoutes);
  });
};

export default fp(adminRoutesPlugin, { name: 'admin-routes' });
