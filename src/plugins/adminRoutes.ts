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
// Authorized by HUB-1674 (E-FE-7 S1) — adminSystemHealthRoutes: 4 GET endpoints for the System Health FE
// Authorized by HUB-1680 (E-FE-9 S1) — adminCustomerHealthRoutes: 2 GET endpoints for the Customer Health FE
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
import adminSystemHealthRoutes from '../routes/admin/systemHealth.js';
import adminCustomerHealthRoutes from '../routes/admin/customerHealth.js';
import adminFailedPaymentsRoutes from '../routes/admin/failedPayments.js';
import adminGrcRoutes from '../routes/admin/grc.js';
import adminGrcVendorCloudPolicyRoutes from '../routes/admin/grcVendorCloudPolicy.js';
// HUB-1733/1734 (E-V2-PP-2 S4/S5, HUB-1726, HUB-1701) — custom-quote CRUD + approval routes
import adminCustomQuotesRoutes from '../routes/admin/customQuotes.js';
// HUB-1747 (E-V2-PP-3 S7, HUB-1727, HUB-1701) — pricing simulation preview endpoint
import adminPricingSimulateRoutes from '../routes/admin/pricingSimulate.js';
// HUB-1752/1756 (E-V2-PP-4 S3/S7, HUB-1728, HUB-1701) — grandfather CRUD + upgrade suggestions
import adminGrandfatherRoutes from '../routes/admin/grandfathers.js';

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
    // HUB-1674 (E-FE-7 S1): System Health GET endpoints (portfolio / queues / stripe / audit-errors)
    await scope.register(adminSystemHealthRoutes);
    // HUB-1680 (E-FE-9 S1): Customer Health GET endpoints (list + drill-in)
    await scope.register(adminCustomerHealthRoutes);
    // HUB-1686 (E-FE-13 S1): Failed Payment Tracker endpoints (5 endpoints)
    await scope.register(adminFailedPaymentsRoutes);
    // HUB-1385 (E-CMP-WAVE4 S2): GRC-Lite Wave 4 register CRUD (11 endpoints)
    await scope.register(adminGrcRoutes);
    // HUB-1423 (E-CMP-WAVE4b S2): GRC-Lite Wave 4b register CRUD (13 endpoints)
    await scope.register(adminGrcVendorCloudPolicyRoutes);
    // HUB-1733/1734 (E-V2-PP-2 S4/S5): custom-quote CRUD + approval
    await scope.register(adminCustomQuotesRoutes);
    // HUB-1747 (E-V2-PP-3 S7): pricing simulation preview
    await scope.register(adminPricingSimulateRoutes);
    // HUB-1752/1756 (E-V2-PP-4 S3/S7): grandfather CRUD + upgrade suggestions
    await scope.register(adminGrandfatherRoutes);
  });
};

export default fp(adminRoutesPlugin, { name: 'admin-routes' });
