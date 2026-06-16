// Authorized by HUB-801 — escalation rule CRUD; 2-tier cap per (tenant, product, alert_type); operator JWT
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';
import logger from '../lib/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

interface EscalationContact {
  type: 'email' | 'sms' | 'webhook';
  value: string;
}

function validateContacts(contacts: unknown): EscalationContact[] {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new AppError(400, 'escalation_contacts must be a non-empty array');
  }
  for (const c of contacts) {
    if (!c || typeof c !== 'object') throw new AppError(400, 'Each escalation contact must be an object');
    const contact = c as Record<string, unknown>;
    if (!['email', 'sms', 'webhook'].includes(contact.type as string)) {
      throw new AppError(400, `escalation_contacts[].type must be 'email', 'sms', or 'webhook'`);
    }
    if (typeof contact.value !== 'string' || contact.value.trim() === '') {
      throw new AppError(400, 'escalation_contacts[].value must be a non-empty string');
    }
  }
  return contacts as EscalationContact[];
}

const escalationRuleRoutes: FastifyPluginAsync = async (fastify) => {
  // POST — create escalation rule; 2-tier cap per (tenant, product, alert_type)
  fastify.post(
    '/api/v1/escalation/:tenantId/:productId/rules',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, productId } = request.params as { tenantId: string; productId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');

      const body = request.body as {
        tier?: unknown;
        threshold_minutes?: unknown;
        alert_type?: unknown;
        escalation_contacts?: unknown;
      };

      const { tier, threshold_minutes, alert_type, escalation_contacts } = body;

      if (tier !== 1 && tier !== 2) {
        throw new AppError(400, 'tier must be 1 or 2');
      }
      if (typeof threshold_minutes !== 'number' || !Number.isInteger(threshold_minutes) || threshold_minutes <= 0) {
        throw new AppError(400, 'threshold_minutes must be a positive integer');
      }
      if (typeof alert_type !== 'string' || alert_type.trim() === '') {
        throw new AppError(400, 'alert_type is required');
      }
      const contacts = validateContacts(escalation_contacts);

      const pool = getPool();

      // 2-tier cap check: max 2 rules per (tenant, product, alert_type)
      const { rows: countRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM escalation_rules WHERE tenant_id = $1 AND product_id = $2 AND alert_type = $3`,
        [tenantId, productId, alert_type],
      );
      if (parseInt(countRows[0]!.count, 10) >= 2) {
        throw new AppError(409, 'Escalation rule tier limit reached (max 2 tiers)');
      }

      try {
        const { rows } = await pool.query(
          `INSERT INTO escalation_rules (tenant_id, product_id, alert_type, tier, threshold_minutes, escalation_contacts)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, tenant_id, product_id, alert_type, tier, threshold_minutes, escalation_contacts`,
          [tenantId, productId, alert_type, tier, threshold_minutes, JSON.stringify(contacts)],
        );
        logger.info({ ruleId: (rows[0] as { id: string }).id, tenantId, productId, alert_type, tier }, 'Escalation rule created');
        return reply.status(201).send(rows[0]);
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') throw new AppError(409, 'Escalation rule tier limit reached (max 2 tiers)');
        throw err;
      }
    },
  );

  // GET — list all rules for tenant/product ordered by alert_type, tier
  fastify.get(
    '/api/v1/escalation/:tenantId/:productId/rules',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, productId } = request.params as { tenantId: string; productId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, tenant_id, product_id, alert_type, tier, threshold_minutes, escalation_contacts
         FROM escalation_rules
         WHERE tenant_id = $1 AND product_id = $2
         ORDER BY alert_type ASC, tier ASC`,
        [tenantId, productId],
      );
      return reply.status(200).send({ rules: rows });
    },
  );

  // DELETE — remove rule by id; 404 if not found for this tenant
  fastify.delete(
    '/api/v1/escalation/:tenantId/:productId/rules/:ruleId',
    { preHandler: [fastify.authenticateOperator] },
    async (request, reply) => {
      const { tenantId, productId, ruleId } = request.params as { tenantId: string; productId: string; ruleId: string };
      assertUUID(tenantId, 'tenantId');
      assertUUID(productId, 'productId');
      assertUUID(ruleId, 'ruleId');

      const pool = getPool();
      const { rowCount } = await pool.query(
        `DELETE FROM escalation_rules WHERE id = $1 AND tenant_id = $2 AND product_id = $3`,
        [ruleId, tenantId, productId],
      );
      if (rowCount === 0) throw new AppError(404, 'Escalation rule not found');
      return reply.status(204).send();
    },
  );
};

export default fp(escalationRuleRoutes, { name: 'escalation-rule-routes' });
