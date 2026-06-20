// Authorized by HUB-4.1 L2 — Red Team H2: wrap business operator routes under operatorRbacHook
// to enforce tenant_admin cannot cross-access other tenants' data.
// Pattern mirrors adminRoutesPlugin: scoped inner plugin so the hook stays within this scope only.
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { operatorRbacHook } from '../hooks/operatorRbac.js';
import billingRoutes from '../routes/billing.js';
import versionsRoutes from '../routes/versions.js';
import pricingModelRoutes from '../routes/pricingModelRoutes.js';
import marginRoutes from '../routes/marginRoutes.js';
import costQueryRoutes from '../routes/costQueryRoutes.js';
import alertRoutes from '../routes/alertRoutes.js';
import notificationChannelRoutes from '../routes/notificationChannelRoutes.js';
import inAppNotificationRoutes from '../routes/inAppNotificationRoutes.js';
import escalationRuleRoutes from '../routes/escalationRuleRoutes.js';
import hookRoutes from '../routes/hookRoutes.js';

const businessOperatorRoutesPlugin: FastifyPluginAsync = async (fastify) => {
  // Scoped inner plugin — operatorRbacHook stays within this scope.
  // Routes that use :tenantId enforce tenant_admin isolation via the hook.
  // Routes without :tenantId (versionsRoutes, pricingModelRoutes, marginRoutes)
  // become implicitly super_admin-only: tenant_admin receives 403, which is correct.
  await fastify.register(async (scope) => {
    scope.addHook('onRequest', operatorRbacHook);
    await scope.register(billingRoutes);
    await scope.register(versionsRoutes);
    await scope.register(pricingModelRoutes);
    await scope.register(marginRoutes);
    await scope.register(costQueryRoutes);
    await scope.register(alertRoutes);
    await scope.register(notificationChannelRoutes);
    await scope.register(inAppNotificationRoutes);
    await scope.register(escalationRuleRoutes);
    await scope.register(hookRoutes);
  });
};

export default fp(businessOperatorRoutesPlugin, { name: 'business-operator-routes' });
