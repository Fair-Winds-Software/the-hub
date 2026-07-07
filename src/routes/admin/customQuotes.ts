// Authorized by HUB-1733 + HUB-1734 (E-V2-PP-2 S4/S5, HUB-1726, HUB-1701) —
// Custom-quote admin routes. All endpoints sit under adminRoutesPlugin's
// operatorRbacHook scope; RBAC gate is super_admin-only (matches HUB-1454 pattern
// for portfolio-scoped operator work).
//
// Endpoints:
//   POST /api/v1/admin/billing/quotes                 — S4 create draft
//   GET  /api/v1/admin/billing/quotes                 — S9 list (status filter + pagination)
//   GET  /api/v1/admin/billing/quotes/:id             — detail view
//   POST /api/v1/admin/billing/quotes/:id/approve     — S5 approve (two-role attestation)
//   POST /api/v1/admin/billing/quotes/:id/reject      — S5 reject

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/AppError.js';
import {
  createQuote,
  decideQuote,
  listQuotes,
  type CustomQuoteRow,
} from '../../services/customQuoteService.js';
import { getPool } from '../../db/pool.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSuperAdmin(request: FastifyRequest): void {
  if (!request.operatorUser) throw new AppError(401, 'Unauthenticated');
  if (request.operatorUser.role !== 'super_admin') {
    throw new AppError(403, 'super_admin role required');
  }
}

function assertUuidParam(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new AppError(400, 'invalid id: expected UUID');
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new AppError(400, `missing required field: ${field}`);
  }
  return v;
}

const adminCustomQuotesRoutes: FastifyPluginAsync = async (fastify) => {
  // ── S4 POST /quotes ────────────────────────────────────────────────────
  fastify.post('/api/v1/admin/billing/quotes', async (request, reply) => {
    assertSuperAdmin(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tenant_id = requireString(body, 'tenant_id');
    const product_id = requireString(body, 'product_id');
    const line_items = body['line_items'];
    if (!Array.isArray(line_items)) {
      throw new AppError(400, 'line_items must be an array');
    }
    const expires_at = 'expires_at' in body ? (body['expires_at'] as string | null) : null;

    const operator_id = request.operatorUser!.operator_id;

    const { quote, line_items: liRows } = await createQuote({
      tenant_id,
      product_id,
      operator_id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      line_items: line_items as any,
      expires_at,
    });
    return reply.status(201).send({ ...quote, line_items: liRows });
  });

  // ── S9 GET /quotes list ────────────────────────────────────────────────
  fastify.get('/api/v1/admin/billing/quotes', async (request, reply) => {
    assertSuperAdmin(request);
    const q = request.query as Record<string, string | undefined>;
    const tenant_id = q['tenant_id'];
    if (!tenant_id) throw new AppError(400, 'tenant_id query param is required');
    const status = q['status'];
    const page = q['page'] ? parseInt(q['page'], 10) : undefined;
    const pageSize = q['pageSize'] ? parseInt(q['pageSize'], 10) : undefined;
    const result = await listQuotes(tenant_id, { status, page, pageSize });
    return reply.send(result);
  });

  // ── GET /quotes/:id detail ─────────────────────────────────────────────
  fastify.get('/api/v1/admin/billing/quotes/:id', async (request, reply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id?: unknown };
    assertUuidParam(id);
    const pool = getPool();
    const { rows } = await pool.query<CustomQuoteRow>(
      `SELECT * FROM custom_quotes WHERE id = $1`, [id],
    );
    const quote = rows[0];
    if (!quote) throw new AppError(404, 'quote not found');
    const { rows: liRows } = await pool.query(
      `SELECT * FROM custom_quote_line_items WHERE quote_id = $1 ORDER BY sort_order ASC`,
      [id],
    );
    const { rows: apprRows } = await pool.query(
      `SELECT * FROM custom_quote_approvals WHERE quote_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    return reply.send({ ...quote, line_items: liRows, approvals: apprRows });
  });

  // ── S5 POST /quotes/:id/approve ────────────────────────────────────────
  fastify.post('/api/v1/admin/billing/quotes/:id/approve', async (request, reply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id?: unknown };
    assertUuidParam(id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason = requireString(body, 'reason');
    const approver = request.operatorUser!.operator_id;
    const { quote, approval } = await decideQuote(id, 'approved', reason, approver);
    return reply.status(200).send({ ...quote, approval });
  });

  // ── S5 POST /quotes/:id/reject ─────────────────────────────────────────
  fastify.post('/api/v1/admin/billing/quotes/:id/reject', async (request, reply) => {
    assertSuperAdmin(request);
    const { id } = request.params as { id?: unknown };
    assertUuidParam(id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason = requireString(body, 'reason');
    const approver = request.operatorUser!.operator_id;
    const { quote, approval } = await decideQuote(id, 'rejected', reason, approver);
    return reply.status(200).send({ ...quote, approval });
  });
};

export default adminCustomQuotesRoutes;
