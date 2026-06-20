// Authorized by HUB-844 — POST /api/v1/hooks/:tenantId; AES-256-GCM hmac_secret encryption; operator JWT
// Authorized by HUB-4.1 L2 — Red Team H3: SSRF guard — block RFC-1918, link-local, and metadata IPs
// Authorized by HUB-851 — GET /api/v1/hooks/:tenantId; secret masking via jsonb_set; operator JWT
// Authorized by HUB-858 — DELETE /api/v1/hooks/:tenantId/:hookId; 204/404; ON DELETE CASCADE; operator JWT
// Authorized by HUB-872 — GET /api/v1/hooks/:tenantId/:hookId/executions; preflight ownership check; operator JWT
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { encryptHookSecret } from '../services/hookDeliveryService.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

// SSRF guard: blocks RFC-1918, link-local, loopback, and cloud metadata targets.
// Returns true when the URL resolves to an internal network destination.
function isSsrfUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  const BLOCKED_HOSTS = [
    'localhost',
    '169.254.169.254',    // AWS / Azure / GCP metadata (IPv4 link-local)
    'fd00:ec2::254',      // AWS metadata (IPv6)
    '100.100.100.200',    // Alibaba Cloud metadata
    'metadata.google.internal',
  ];
  if (BLOCKED_HOSTS.includes(host)) return true;

  // Block IPv4 private, loopback, and link-local ranges
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) return true;
  }

  // Block IPv6 loopback and unique-local (fc00::/7)
  if (host === '::1' || /^f[cd]/i.test(host)) return true;

  return false;
}

const hookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST — register a new webhook
  fastify.post(
    '/api/v1/hooks/:tenantId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      assertUUID(tenantId, 'tenantId');

      const body = request.body as {
        trigger_event_type?: unknown;
        action_config?: unknown;
        product_id?: unknown;
        enabled?: unknown;
      };

      const { trigger_event_type, action_config, product_id, enabled } = body;

      if (typeof trigger_event_type !== 'string' || trigger_event_type.trim() === '') {
        throw new AppError(400, 'trigger_event_type is required');
      }

      const cfg = action_config as Record<string, unknown> | undefined;
      if (!cfg || typeof cfg.url !== 'string' || !cfg.url.startsWith('https://')) {
        throw new AppError(400, 'action_config.url must be an https:// URL');
      }
      if (isSsrfUrl(cfg.url as string)) {
        throw new AppError(400, 'action_config.url must point to a public HTTPS endpoint');
      }
      if (typeof cfg.hmac_secret !== 'string' || cfg.hmac_secret.trim() === '') {
        throw new AppError(400, 'action_config.hmac_secret is required');
      }
      if (product_id !== undefined && product_id !== null) {
        assertUUID(product_id as string, 'product_id');
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        throw new AppError(400, 'enabled must be a boolean');
      }

      const encryptedSecret = encryptHookSecret(cfg.hmac_secret as string);
      const actionConfig = { url: cfg.url, hmac_secret: encryptedSecret };
      const resolvedProductId = product_id ?? null;
      const resolvedEnabled = enabled ?? true;

      const pool = getPool();
      const { rows } = await pool.query(
        `INSERT INTO workflow_hooks (tenant_id, product_id, trigger_event_type, action_type, action_config, enabled)
         VALUES ($1, $2, $3, 'webhook', $4, $5)
         RETURNING id, tenant_id, product_id, trigger_event_type, action_type,
                   jsonb_set(action_config, '{hmac_secret}', '"***"') AS action_config,
                   enabled, created_at`,
        [tenantId, resolvedProductId, trigger_event_type, JSON.stringify(actionConfig), resolvedEnabled],
      );

      const row = rows[0] as { id: string };
      logger.info({ hookId: row.id, tenantId, trigger_event_type }, 'Workflow hook registered');
      return reply.status(201).send(row);
    },
  );

  // GET — list all hooks for tenant (hmac_secret masked)
  fastify.get(
    '/api/v1/hooks/:tenantId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      assertUUID(tenantId, 'tenantId');

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, tenant_id, product_id, trigger_event_type, action_type,
                jsonb_set(action_config, '{hmac_secret}', '"***"') AS action_config,
                enabled, created_at
         FROM workflow_hooks
         WHERE tenant_id = $1
         ORDER BY created_at ASC`,
        [tenantId],
      );
      return reply.status(200).send(rows);
    },
  );

  // DELETE — remove hook by id; 204 / 404
  fastify.delete(
    '/api/v1/hooks/:tenantId/:hookId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, hookId } = request.params as { tenantId: string; hookId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(hookId, 'hookId');

      const pool = getPool();
      const { rowCount } = await pool.query(
        `DELETE FROM workflow_hooks WHERE id = $1 AND tenant_id = $2`,
        [hookId, tenantId],
      );
      if (rowCount === 0) throw new AppError(404, 'Hook not found');
      return reply.status(204).send();
    },
  );

  // GET — execution history for a hook
  fastify.get(
    '/api/v1/hooks/:tenantId/:hookId/executions',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, hookId } = request.params as { tenantId: string; hookId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(hookId, 'hookId');

      const pool = getPool();

      // Preflight: verify hook exists and belongs to this tenant
      const { rows: hookRows } = await pool.query(
        `SELECT id FROM workflow_hooks WHERE id = $1 AND tenant_id = $2`,
        [hookId, tenantId],
      );
      if (hookRows.length === 0) throw new AppError(404, 'Hook not found');

      const { rows } = await pool.query(
        `SELECT id, hook_id, alert_event_id, status, status_code, duration_ms, error, attempted_at
         FROM workflow_hook_executions
         WHERE hook_id = $1
         ORDER BY attempted_at DESC`,
        [hookId],
      );
      return reply.status(200).send(rows);
    },
  );
};

export default fp(hookRoutes, { name: 'hook-routes' });
