// Authorized by HUB-1752 + HUB-1756 (E-V2-PP-4 S3/S7, HUB-1728, HUB-1701) —
// Upgrade-suggestion API + grandfather CRUD for the operator Console editor.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import { getPool } from '../../db/pool.js';
import {
  getUpgradeSuggestion,
  dismissUpgradeSuggestion,
} from '../../services/grandfatherService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertOperator(req: FastifyRequest): void {
  if (!req.operatorUser) throw new AppError(401, 'Unauthenticated');
}
function assertSuperAdmin(req: FastifyRequest): void {
  assertOperator(req);
  if (req.operatorUser!.role !== 'super_admin') {
    throw new AppError(403, 'super_admin role required');
  }
}
function assertUuidParam(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new AppError(400, 'invalid id: expected UUID');
  }
}

const adminGrandfatherRoutes: FastifyPluginAsync = async (fastify) => {
  // ── S3 upgrade suggestion API ─────────────────────────────────────────
  fastify.get('/api/v1/tenants/:tenantId/products/:productId/upgrade-suggestion', async (request, reply) => {
    assertOperator(request);
    const { tenantId, productId } = request.params as { tenantId?: unknown; productId?: unknown };
    assertUuidParam(tenantId);
    assertUuidParam(productId);
    const suggestion = await getUpgradeSuggestion(tenantId, productId);
    return reply.send({ suggestion });
  });

  fastify.post('/api/v1/tenants/:tenantId/products/:productId/upgrade-suggestion/dismiss', async (request, reply) => {
    assertOperator(request);
    const { tenantId, productId } = request.params as { tenantId?: unknown; productId?: unknown };
    assertUuidParam(tenantId);
    assertUuidParam(productId);
    const result = await dismissUpgradeSuggestion(tenantId, productId);
    if (result === null) throw new AppError(404, 'no active suggestion to dismiss');
    return reply.send({ dismissed: true, cooldown_until: result.cooldown_until });
  });

  // ── S7 grandfather CRUD (operator Console) ─────────────────────────────
  fastify.get('/api/v1/admin/tenants/:tenantId/grandfathers', async (request, reply) => {
    assertSuperAdmin(request);
    const { tenantId } = request.params as { tenantId?: unknown };
    assertUuidParam(tenantId);
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM pricing_grandfathers WHERE tenant_id = $1 ORDER BY effective_from DESC`,
      [tenantId],
    );
    return reply.send({ data: rows, total: rows.length });
  });

  fastify.post('/api/v1/admin/tenants/:tenantId/grandfathers', async (request, reply) => {
    assertSuperAdmin(request);
    const { tenantId } = request.params as { tenantId?: unknown };
    assertUuidParam(tenantId);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const product_id = body['product_id'];
    if (typeof product_id !== 'string' || !UUID_RE.test(product_id)) {
      throw new AppError(400, 'product_id is required (UUID)');
    }
    const policy_type = body['policy_type'];
    const delta_cents = body['delta_cents'];
    const effective_from = body['effective_from'];
    const expires_at = body['expires_at'];
    const terms = body['terms'];
    if (typeof policy_type !== 'string') throw new AppError(400, 'policy_type is required');
    if (typeof delta_cents !== 'number' || !Number.isInteger(delta_cents) || delta_cents === 0) {
      throw new AppError(400, 'delta_cents must be a non-zero integer');
    }
    if (typeof effective_from !== 'string' || typeof expires_at !== 'string') {
      throw new AppError(400, 'effective_from and expires_at must be date strings');
    }
    if (typeof terms !== 'string' || terms.trim().length < 20) {
      throw new AppError(400, 'terms must be at least 20 characters');
    }
    const operatorId = request.operatorUser!.operator_id;
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO pricing_grandfathers
         (tenant_id, product_id, policy_type, delta_cents, effective_from,
          expires_at, terms, created_by_operator_id)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8) RETURNING *`,
      [tenantId, product_id, policy_type, delta_cents, effective_from, expires_at, terms, operatorId],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.delete('/api/v1/admin/tenants/:tenantId/grandfathers/:id', async (request, reply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id?: unknown };
    assertUuidParam(id);
    // Archive = set expires_at = CURRENT_DATE (grandfather becomes inactive from today).
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE pricing_grandfathers
          SET expires_at = CURRENT_DATE
        WHERE id = $1 AND expires_at > CURRENT_DATE
        RETURNING *`,
      [id],
    );
    if (rows.length === 0) throw new AppError(404, 'grandfather not found or already archived');
    return reply.send(rows[0]);
  });
};

export default adminGrandfatherRoutes;
