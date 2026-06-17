// Authorized by HUB-1021 — compliance control registry CRUD, product registration + HMAC secret, burn-in state machine, control binding management
// Authorized by HUB-1048 — GET /posture, GET /verdicts, GET /history query endpoints
import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { encryptHookSecret } from '../../services/hookDeliveryService.js';
import {
  getProductPosture,
  getProductCurrentVerdicts,
  getProductVerdictHistory,
} from '../../services/complianceEvaluationService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(v: string, label: string): void {
  if (!UUID_RE.test(v)) throw new AppError(400, `${label} must be a valid UUID`);
}

function assertSuperAdmin(request: { operatorUser?: { role: string } }): void {
  if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
}

async function assertProductAccess(
  request: { operatorUser?: { role: string; tenant_id: string | null } },
  productId: string,
  pool: Pool,
): Promise<void> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM products WHERE id = $1 AND active = true`,
    [productId],
  );
  if (rows.length === 0) throw new AppError(404, 'Product not found');
  const op = request.operatorUser!;
  if (op.role !== 'super_admin' && op.tenant_id !== rows[0]!.tenant_id) {
    throw new AppError(403, 'Forbidden');
  }
}

const adminComplianceRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool();

  // ── Control registry ───────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/compliance/controls', async (request, reply) => {
    assertSuperAdmin(request);
    const b = request.body as {
      control_id: string;
      name: string;
      description?: string;
      tsc_category: string;
      control_class: 'automated' | 'human';
      signal_schema?: unknown;
      eval_cadence: 'daily' | 'weekly' | 'monthly' | 'continuous';
    };

    if (!b.control_id || !b.name || !b.tsc_category || !b.control_class || !b.eval_cadence) {
      throw new AppError(400, 'control_id, name, tsc_category, control_class, and eval_cadence are required');
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO compliance_controls (control_id, name, description, tsc_category, control_class, signal_schema, eval_cadence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        b.control_id,
        b.name,
        b.description ?? null,
        b.tsc_category,
        b.control_class,
        b.signal_schema != null ? JSON.stringify(b.signal_schema) : null,
        b.eval_cadence,
      ],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.get('/api/v1/admin/compliance/controls', async (_request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, control_id, name, description, tsc_category, control_class, signal_schema, eval_cadence, active, created_at
       FROM compliance_controls
       ORDER BY control_id ASC`,
    );
    return reply.send(rows);
  });

  fastify.put('/api/v1/admin/compliance/controls/:controlId', async (request, reply) => {
    assertSuperAdmin(request);
    const { controlId } = request.params as { controlId: string };
    assertUUID(controlId, 'controlId');

    const b = request.body as Partial<{
      name: string;
      description: string;
      tsc_category: string;
      control_class: 'automated' | 'human';
      signal_schema: unknown;
      eval_cadence: 'daily' | 'weekly' | 'monthly' | 'continuous';
      active: boolean;
    }>;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (b.name !== undefined) { params.push(b.name); sets.push(`name = $${params.length}`); }
    if (b.description !== undefined) { params.push(b.description); sets.push(`description = $${params.length}`); }
    if (b.tsc_category !== undefined) { params.push(b.tsc_category); sets.push(`tsc_category = $${params.length}`); }
    if (b.control_class !== undefined) { params.push(b.control_class); sets.push(`control_class = $${params.length}`); }
    if (b.signal_schema !== undefined) { params.push(JSON.stringify(b.signal_schema)); sets.push(`signal_schema = $${params.length}`); }
    if (b.eval_cadence !== undefined) { params.push(b.eval_cadence); sets.push(`eval_cadence = $${params.length}`); }
    if (b.active !== undefined) { params.push(b.active); sets.push(`active = $${params.length}`); }

    if (sets.length === 0) throw new AppError(400, 'No fields to update');

    params.push(controlId);
    const { rows } = await pool.query(
      `UPDATE compliance_controls SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (rows.length === 0) throw new AppError(404, 'Control not found');
    return reply.send(rows[0]);
  });

  fastify.delete('/api/v1/admin/compliance/controls/:controlId', async (request, reply) => {
    assertSuperAdmin(request);
    const { controlId } = request.params as { controlId: string };
    assertUUID(controlId, 'controlId');

    const { rows } = await pool.query(
      `UPDATE compliance_controls SET active = false WHERE id = $1 AND active = true RETURNING id`,
      [controlId],
    );
    if (rows.length === 0) throw new AppError(404, 'Control not found');
    return reply.status(204).send();
  });

  // ── Product registration ────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/compliance/products/:productId/register', async (request, reply) => {
    assertSuperAdmin(request);
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');

    const { rows: pRows } = await pool.query<{ id: string }>(
      `SELECT id FROM products WHERE id = $1 AND active = true`,
      [productId],
    );
    if (pRows.length === 0) throw new AppError(404, 'Product not found');

    const secret = randomBytes(32).toString('hex');
    const hmacSecretEnc = encryptHookSecret(secret);

    const { rows } = await pool.query<{
      id: string;
      burn_in_state: string;
      burn_in_started: Date;
    }>(
      `INSERT INTO compliance_product_registrations (product_id, hmac_secret_enc)
       VALUES ($1, $2)
       ON CONFLICT (product_id) DO NOTHING
       RETURNING id, burn_in_state, burn_in_started`,
      [productId, hmacSecretEnc],
    );

    if (rows.length === 0) throw new AppError(409, 'Product is already registered for compliance');

    // hmac_secret returned in plaintext exactly once so the operator can configure LaunchKit
    return reply.status(201).send({
      id: rows[0]!.id,
      product_id: productId,
      burn_in_state: rows[0]!.burn_in_state,
      burn_in_started: rows[0]!.burn_in_started,
      hmac_secret: secret,
    });
  });

  fastify.get('/api/v1/admin/compliance/products/:productId/registration', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');
    await assertProductAccess(request, productId, pool);

    const { rows } = await pool.query<{
      id: string;
      burn_in_state: string;
      burn_in_started: Date;
      burn_in_ended: Date | null;
      active: boolean;
      created_at: Date;
    }>(
      `SELECT id, burn_in_state, burn_in_started, burn_in_ended, active, created_at
       FROM compliance_product_registrations
       WHERE product_id = $1`,
      [productId],
    );
    if (rows.length === 0) throw new AppError(404, 'Product is not registered for compliance');
    return reply.send({ ...rows[0], product_id: productId, hmac_secret: '***' });
  });

  fastify.post('/api/v1/admin/compliance/products/:productId/promote', async (request, reply) => {
    assertSuperAdmin(request);
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');

    const { rows } = await pool.query<{ id: string; burn_in_state: string }>(
      `UPDATE compliance_product_registrations
       SET burn_in_state = 'enforced', burn_in_ended = NOW()
       WHERE product_id = $1 AND burn_in_state = 'observe'
       RETURNING id, burn_in_state`,
      [productId],
    );
    if (rows.length === 0) throw new AppError(404, 'Product not found or not in observe state');
    return reply.send({ product_id: productId, burn_in_state: rows[0]!.burn_in_state });
  });

  // ── Control bindings ────────────────────────────────────────────────────────

  fastify.post('/api/v1/admin/compliance/products/:productId/bindings', async (request, reply) => {
    assertSuperAdmin(request);
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');

    const b = request.body as { control_id: string; binding_source?: 'default' | 'override' };
    if (!b.control_id) throw new AppError(400, 'control_id is required');
    assertUUID(b.control_id, 'control_id');

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO product_control_bindings (product_id, control_id, binding_source)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, control_id) DO UPDATE SET active = true, binding_source = EXCLUDED.binding_source
       RETURNING id`,
      [productId, b.control_id, b.binding_source ?? 'default'],
    );
    return reply.status(201).send(rows[0]);
  });

  fastify.get('/api/v1/admin/compliance/products/:productId/bindings', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');
    await assertProductAccess(request, productId, pool);

    const { rows } = await pool.query(
      `SELECT b.id, b.control_id, b.binding_source, b.active, b.created_at,
              c.control_id AS control_key, c.name AS control_name, c.tsc_category
       FROM product_control_bindings b
       JOIN compliance_controls c ON c.id = b.control_id
       WHERE b.product_id = $1 AND b.active = true
       ORDER BY c.control_id ASC`,
      [productId],
    );
    return reply.send(rows);
  });

  fastify.delete(
    '/api/v1/admin/compliance/products/:productId/bindings/:controlId',
    async (request, reply) => {
      assertSuperAdmin(request);
      const { productId, controlId } = request.params as { productId: string; controlId: string };
      assertUUID(productId, 'productId');
      assertUUID(controlId, 'controlId');

      const { rows } = await pool.query(
        `UPDATE product_control_bindings SET active = false
         WHERE product_id = $1 AND control_id = $2 AND active = true
         RETURNING id`,
        [productId, controlId],
      );
      if (rows.length === 0) throw new AppError(404, 'Binding not found');
      return reply.status(204).send();
    },
  );
  // ── Evaluation query API (HUB-1048) ────────────────────────────────────────

  fastify.get('/api/v1/admin/compliance/products/:productId/posture', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');
    await assertProductAccess(request, productId, pool);
    return reply.send(await getProductPosture(productId));
  });

  fastify.get('/api/v1/admin/compliance/products/:productId/verdicts', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');
    await assertProductAccess(request, productId, pool);
    return reply.send(await getProductCurrentVerdicts(productId));
  });

  fastify.get('/api/v1/admin/compliance/products/:productId/history', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');
    await assertProductAccess(request, productId, pool);

    const q = request.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(q.limit ?? '50', 10), 200);
    const offset = parseInt(q.offset ?? '0', 10);

    return reply.send(await getProductVerdictHistory(productId, limit, offset));
  });
};

export default adminComplianceRoutes;
