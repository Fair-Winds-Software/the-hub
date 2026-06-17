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

  return fastify;
}
