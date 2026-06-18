// Authorized by HUB-77 — buildApp() factory; plugin registration order is load-bearing for all 37 downstream Epics
// Authorized by HUB-78 — loggerPlugin registered second; createServerOptions() replaces static serverOptions
// Authorized by HUB-79 — errorHandlerPlugin registered third; AppError + canonical {error:{code,message}} format
// Authorized by HUB-99 — rateLimitPlugin registered fourth; Redis-backed rate limiting with fail-open
// Authorized by HUB-98 — authPlugin registered fifth; service JWT issuance + authenticate decorator
// Authorized by HUB-112 — operatorAuthPlugin registered sixth; operator JWT issuance + authenticateOperator decorator
// Authorized by HUB-113 — corsPlugin registered first (locked E2 order); CORS_ORIGINS env-configurable
// Authorized by HUB-188 — stripeWebhookPlugin registered after auth; no JWT, HMAC-only auth
// Authorized by HUB-216 — traceparentPlugin registered before loggerPlugin; W3C trace correlation on every request
// Authorized by HUB-230 — healthRoutes registered at position 8; GET /health probe-backed; no auth; no rate-limit
// Authorized by HUB-1469 — catalogPlanRoutes registered in business routes slot; POST/GET/PATCH /api/v1/catalog/plans
// Authorized by HUB-1470 — BILL-004: createSubscription now accepts planId; resolves stripe_price_id internally
// Authorized by HUB-1465 — 036 migration: plans + plan_archive_ledger; stripe_product_id on products
// Authorized by HUB-1471 — planCatalogService integration test suite (STRIPE_INTEGRATION=1)
// Authorized by HUB-1477 — catalogAddOnRoutes + tenantAddOnRoutes: add-on catalog + tenant activation endpoints
// Authorized by HUB-349 — sdkRoutes registered in business routes slot; POST /api/v1/sdk/version-report
// Authorized by HUB-350 — versionsRoutes registered in operator routes slot; GET /api/v1/products/:productId/versions
// Authorized by HUB-552 — leasesRoutes registered in business routes slot; POST /api/v1/leases/issue and verify
// Authorized by HUB-553 — leasesRoutes extended with operator lease lifecycle endpoints
// Authorized by HUB-454 — billingRoutes registered in operator routes slot; GET /api/v1/billing/subscriptions/:tenantId
// Authorized by HUB-594 — pricingModelRoutes registered in operator routes slot; pricing model activation and retrieval
// Authorized by HUB-629 — usageRoutes registered in business routes slot; POST /api/v1/usage/events; service auth
// Authorized by HUB-657 — marginRoutes registered in operator routes slot; POST + GET /api/v1/pricing/margin-config
// Authorized by HUB-692 — pricingActiveModelRoutes registered in business routes slot; GET /api/v1/pricing/models/:productId/active; service auth
// Authorized by HUB-699 — costQueryRoutes registered in operator routes slot; calculate, cost history, current-period, margin summary
// Authorized by HUB-725 — alertRoutes registered in operator routes slot; POST acknowledge/resolve, GET paginated list
// Authorized by HUB-766 — notificationChannelRoutes registered; full CRUD for notification_channels
// Authorized by HUB-767 — inAppNotificationRoutes registered; GET paginated list + PATCH mark-read
// Authorized by HUB-801 — escalationRuleRoutes registered; POST/GET/DELETE escalation rules
// Authorized by HUB-844 — hookRoutes registered; POST/GET/DELETE hooks + GET execution history
// Authorized by HUB-1034 — adminRoutesPlugin registered; operator admin auth + RBAC-protected routes
// Authorized by HUB-1086 — adminTenantRoutes registered via adminRoutesPlugin; tenant CRUD
// Authorized by HUB-1103 — adminProductRoutes registered via adminRoutesPlugin; product registration + credentials
// Authorized by HUB-1494 — adminBillingRoutes: GET+PUT /admin/tenants/:tenantId/products/:productId/pricing
// Authorized by HUB-1495 — adminBillingRoutes: GET /admin/tenants/:tenantId/invoices (D-005) + /:invoiceId detail
// Authorized by HUB-1496 — adminBillingRoutes: POST+DELETE /admin/tenants/:tenantId/products/:productId/freeze (D-006)
// Authorized by HUB-1497 — adminBillingRoutes: GET /admin/tenants/:tenantId/stripe-customer (super_admin only)
// Authorized by HUB-1499 — 028 migration: idx_alert_events_tenant_status_severity
// Authorized by HUB-1500 — adminNotificationsRoutes: GET /admin/alerts/summary/:tenantId
// Authorized by HUB-1501 — adminNotificationsRoutes: admin alert ack/resolve/list RBAC delegation
// Authorized by HUB-1502 — adminNotificationsRoutes: admin notification channel CRUD
// Authorized by HUB-1503 — adminNotificationsRoutes: admin escalation rule CRUD; 2-tier cap
// Authorized by HUB-1504 — adminNotificationsRoutes: admin workflow hook CRUD; hmac_secret masking
// Authorized by HUB-1506 — 029 migration: tenant_users table; portal auth credentials
// Authorized by HUB-1507 — portalAuthHook: PORTAL_JWT_SECRET; portalUser augmentation
// Authorized by HUB-1508 — portalAuthRoutes: POST /api/v1/portal/auth/login; bcrypt; 60-min JWT
// Authorized by HUB-1509 — portalDataRoutes: GET /api/v1/portal/usage/:productId
// Authorized by HUB-1510 — portalDataRoutes: GET /api/v1/portal/invoices + /:invoiceId (D-005)
// Authorized by HUB-1511 — portalDataRoutes: GET+PUT /api/v1/portal/notifications
// Authorized by HUB-1512 — portalDataRoutes: GET /api/v1/portal/profile
// Authorized by HUB-1019 — 030 migration: compliance_controls, compliance_product_registrations, product_control_bindings
// Authorized by HUB-1020 — 030 migration: compliance_signal_evidence (immutable, content hash, signal_id dedup) + compliance_signal_rejections
// Authorized by HUB-1021 — adminComplianceRoutes: control CRUD + product registration + burn-in promote + bindings
// Authorized by HUB-1023 — complianceSignalPlugin: POST /api/v1/compliance/signals; HMAC-only auth; dedup; rejection log
// Authorized by HUB-1031 — 031 migration: compliance_evaluation_runs + compliance_current_verdicts
// Authorized by HUB-1036 — 031 migration: compliance_verdict_history (immutable) + compliance_posture_scores
// Authorized by HUB-1043 — complianceEvaluationService: daily CRON evaluator; automated+human control verdicts
// Authorized by HUB-1048 — complianceEvaluationService: human evaluator + posture aggregation + query API (posture/verdicts/history)
// Authorized by HUB-1057 — adminComplianceDashboardRoutes: overview, product detail, posture trend (via adminRoutesPlugin)
// Authorized by HUB-1098 — 032 migration: alert_notifications, alert_acknowledgments, alert_rules; adminComplianceAlertsRoutes alert_rules GET/PUT
// Authorized by HUB-1102 — adminComplianceAlertsRoutes: notification list, acknowledge, acknowledge-all
// Authorized by HUB-1118 — complianceEvaluationService: PASS→FAIL transition detection; fireControlFailureAlert hook
// Authorized by HUB-1354 — runHumanEscalationScheduler(): T-7/T-1/T-0/overdue reminder CRON (D-009)
// Authorized by HUB-1355 — runDriftDetectionEngine(): 7-day posture score drop detection CRON (D-010)
// Authorized by HUB-1365 — adminComplianceAlertsRoutes: in-app notification center
// Authorized by HUB-1366 — complianceAlertService: deliverAlert, getAlertRule, fireControlFailureAlert, runHumanEscalationScheduler, runDriftDetectionEngine
// Authorized by HUB-1377 — evidenceExportService: queryEvidence() + export filter types; adminComplianceExportRoutes query endpoint
// Authorized by HUB-1380 — evidenceExportService: generateExportBundle() ZIP + signed manifest; 033 migration: compliance_export_jobs
// Authorized by HUB-1381 — evidenceExportService: buildCoverDocument() auditor markdown summary
// Authorized by HUB-1382 — adminComplianceExportRoutes: POST create job, GET status, GET download stream
// Authorized by HUB-1383 — evidenceExport integration test suite (RUN_INTEGRATION=1)
// Authorized by HUB-1141 — 034 migration: advisor_recommendations + advisor_outcomes tables
// Authorized by HUB-1142 — planAdvisorService: runAdvisor() 5-step engine; adminAdvisorRoutes: run endpoint
// Authorized by HUB-1143 — adminAdvisorRoutes: GET latest recommendation; Redis 60s cache + stale flag
// Authorized by HUB-1144 — adminAdvisorRoutes: POST outcome; cache invalidation
// Authorized by HUB-1145 — plan_advisor BullMQ weekly CRON (D-011 Monday 02:00 UTC); runWeeklyAdvisor()
// Authorized by HUB-1146 — 035 migration + operatorConsoleService: pricing overview endpoint
// Authorized by HUB-1147 — operatorConsoleService: tenant list, plan assignment, discounts, overrides, audit log
// Authorized by HUB-1148 — planAdvisorService: billing-summary, audit-note, recommendation history
// Authorized by HUB-1149 — planAdvisorService: enhanced portfolio summary + CSV export; health badges; churn risk
import Fastify from 'fastify';
import type { DestinationStream } from 'pino';
import { createServerOptions } from './server.js';
import { validateEnv } from './config/env.js';
import corsPlugin from './plugins/cors.js';
import traceparentPlugin from './logging/plugin.js';
import loggerPlugin from './plugins/logger.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import authPlugin from './plugins/auth.js';
import operatorAuthPlugin from './plugins/operatorAuth.js';
import healthRoutes from './routes/health.js';
import healthPlugin from './plugins/health.js';
import pricingRoutes from './pricing/routes.js';
import stripeWebhookPlugin from './webhooks/stripe.js';
import catalogPlanRoutes from './routes/catalog/plans.routes.js';
import catalogAddOnRoutes from './routes/catalog/add-ons.routes.js';
import tenantAddOnRoutes from './routes/billing/tenant-add-ons.routes.js';
import sdkRoutes from './routes/sdk.js';
import versionsRoutes from './routes/versions.js';
import leasesRoutes from './routes/leases.js';
import billingRoutes from './routes/billing.js';
import pricingModelRoutes from './routes/pricingModelRoutes.js';
import usageRoutes from './routes/usageRoutes.js';
import marginRoutes from './routes/marginRoutes.js';
import pricingActiveModelRoutes from './routes/pricingActiveModelRoutes.js';
import costQueryRoutes from './routes/costQueryRoutes.js';
import alertRoutes from './routes/alertRoutes.js';
import notificationChannelRoutes from './routes/notificationChannelRoutes.js';
import inAppNotificationRoutes from './routes/inAppNotificationRoutes.js';
import escalationRuleRoutes from './routes/escalationRuleRoutes.js';
import hookRoutes from './routes/hookRoutes.js';
import adminRoutesPlugin from './plugins/adminRoutes.js';
import portalRoutesPlugin from './plugins/portalRoutes.js';
import complianceSignalPlugin from './routes/compliance/signals.js';

export async function buildApp(dest?: DestinationStream) {
  validateEnv();

  const fastify = Fastify(createServerOptions(dest));

  // Locked E2 plugin registration order (HUB-113 finalises this chain):
  // 1.  CORS plugin              — HUB-113 ✅
  // 2.  Traceparent plugin       — HUB-216 ✅ (must precede loggerPlugin; sets trace_id/span_id first)
  // 3.  Pino logger plugin       — HUB-78  ✅ (adds tenant_id/product_id; onResponse request logging)
  // 4.  Error handler plugin     — HUB-79  ✅
  // 5.  Rate-limit plugin        — HUB-99  ✅
  // 6.  Service auth plugin      — HUB-98  ✅
  // 7.  Operator auth plugin     — HUB-112 ✅
  // 8.  Health check route       — HUB-230 ✅ (GET /health; probe-backed; no auth; no rate-limit)
  // 9.  Health liveness plugin   — HUB-77  ✅ (GET /health/ready; pg+Redis liveness)
  // 10. Stripe webhook           — HUB-188 ✅
  // 11. Business routes          — downstream Epics
  // 12. Operator routes          — downstream Epics
  await fastify.register(corsPlugin);
  await fastify.register(traceparentPlugin);
  await fastify.register(loggerPlugin);
  await fastify.register(errorHandlerPlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(authPlugin);
  await fastify.register(operatorAuthPlugin);
  await fastify.register(healthRoutes);
  await fastify.register(healthPlugin);
  await fastify.register(stripeWebhookPlugin);
  await fastify.register(catalogPlanRoutes);
  await fastify.register(catalogAddOnRoutes);
  await fastify.register(tenantAddOnRoutes);
  await fastify.register(pricingRoutes);
  await fastify.register(sdkRoutes);
  await fastify.register(versionsRoutes);
  await fastify.register(leasesRoutes);
  await fastify.register(billingRoutes);
  await fastify.register(pricingModelRoutes);
  await fastify.register(usageRoutes);
  await fastify.register(marginRoutes);
  await fastify.register(pricingActiveModelRoutes);
  await fastify.register(costQueryRoutes);
  await fastify.register(alertRoutes);
  await fastify.register(notificationChannelRoutes);
  await fastify.register(inAppNotificationRoutes);
  await fastify.register(escalationRuleRoutes);
  await fastify.register(hookRoutes);
  await fastify.register(adminRoutesPlugin);
  await fastify.register(portalRoutesPlugin);
  await fastify.register(complianceSignalPlugin);

  return fastify;
}
