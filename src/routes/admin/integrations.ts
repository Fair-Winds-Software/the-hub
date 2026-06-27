// Authorized by HUB-1594 (E-BE-1 S11, CR-1) — admin integration routes:
//   GET /api/v1/admin/integrations/jira/tickets — per-product ticket counts (HUB-1593)
//   POST /api/v1/admin/integrations/jira/refresh-token-cache — admin recovery after token rotation
//
// Per R1 cross-Epic contract: degraded responses are ALWAYS 200 with `{available: false, reason}`,
// never 503 / 5xx. The Operator Console Dashboard (HUB-1562 E-FE-2) discriminates on the
// `available` flag and renders a "ticket counts unavailable" tile.
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getTicketCounts, clearAuthCache } from '../../services/jiraIntegrationService.js';

const adminIntegrationRoutes: FastifyPluginAsync = async (fastify) => {
  // GET ticket counts. Both super_admin and product_admin may read (read-only signal; no
  // PII). The operatorRbacHook (registered upstream in adminRoutes.ts) has already
  // authenticated the request and populated request.operatorUser.
  fastify.get('/api/v1/admin/integrations/jira/tickets', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const productId = query.productId;
    if (!productId || typeof productId !== 'string' || productId.trim().length === 0) {
      throw new AppError(400, 'MISSING_PRODUCT_ID');
    }
    const result = await getTicketCounts(productId);
    return reply.status(200).send(result);
  });

  // POST refresh-token-cache (HUB-1593 R1 FIX#1 recovery): clears the global auth-failure
  // cache key after the operator rotates the Atlassian token. super_admin only — token
  // rotation is a privileged operation per docs/integrations/atlassian-jira.md.
  fastify.post('/api/v1/admin/integrations/jira/refresh-token-cache', async (request, reply) => {
    if (request.operatorUser?.role !== 'super_admin') {
      throw new AppError(403, 'Forbidden');
    }
    await clearAuthCache();
    return reply.status(200).send({ success: true });
  });
};

export default adminIntegrationRoutes;
