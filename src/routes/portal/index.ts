// Authorized by HUB-1509 — GET /api/v1/portal/usage/:productId (billing_period_costs)
// Authorized by HUB-1510 — GET /api/v1/portal/invoices?productId= + /:invoiceId (D-005)
// Authorized by HUB-1511 — GET /api/v1/portal/notifications + PUT /:id/read (in-app inbox)
// Authorized by HUB-1512 — GET /api/v1/portal/profile (tenant name + active products)
//
// TODO-D-DEF-007: self-serve write operations (subscription management, plan upgrades, payment
// method changes) are deferred pending the portal write scope decision. All /api/v1/portal/*
// routes are read-only at v1 except PUT /api/v1/portal/notifications/:id/read.
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { getInvoices } from '../../services/invoiceService.js';
import type { InvoiceRow } from '../../services/invoiceService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new AppError(400, `${label} must be a valid UUID`);
}

const portalDataRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool();

  // ── Usage summary ────────────────────────────────────────────────────────────

  fastify.get('/api/v1/portal/usage/:productId', async (request, reply) => {
    const { productId } = request.params as { productId: string };
    assertUUID(productId, 'productId');

    const tenantId = request.portalUser!.tenant_id;
    const q = request.query as Record<string, string | undefined>;

    // Verify product belongs to this tenant
    const { rows: productRows } = await pool.query<{ id: string }>(
      `SELECT id FROM products WHERE id = $1 AND tenant_id = $2 AND active = true`,
      [productId, tenantId],
    );
    if (productRows.length === 0) throw new AppError(404, 'Product not found');

    const params: unknown[] = [tenantId, productId];
    let dateFilter = '';
    if (q.from) {
      params.push(new Date(q.from));
      dateFilter += ` AND period_start >= $${params.length}`;
    }
    if (q.to) {
      params.push(new Date(q.to));
      dateFilter += ` AND period_start < $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT period_start, period_end, total_units, total_cost_cents, event_count
       FROM billing_period_costs
       WHERE tenant_id = $1 AND product_id = $2${dateFilter}
       ORDER BY period_start DESC`,
      params,
    );

    return reply.send(rows);
  });

  // ── Invoice list (D-005: productId required) ─────────────────────────────────

  fastify.get('/api/v1/portal/invoices', async (request, reply) => {
    const tenantId = request.portalUser!.tenant_id;
    const q = request.query as Record<string, string | undefined>;

    if (!q.productId) throw new AppError(400, 'productId query param is required (D-005)');
    assertUUID(q.productId, 'productId');

    const limit = q.limit ? parseInt(q.limit, 10) : undefined;
    const invoices = await getInvoices(tenantId, q.productId, limit);
    return reply.send(invoices);
  });

  // ── Invoice detail ─────────────────────────────────────────────────────────

  fastify.get('/api/v1/portal/invoices/:invoiceId', async (request, reply) => {
    const { invoiceId } = request.params as { invoiceId: string };
    assertUUID(invoiceId, 'invoiceId');

    const tenantId = request.portalUser!.tenant_id;

    const { rows } = await pool.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1',
      [invoiceId],
    );
    if (!rows[0] || rows[0].tenant_id !== tenantId) {
      throw new AppError(404, 'Invoice not found');
    }
    return reply.send(rows[0]);
  });

  // ── In-app notifications ───────────────────────────────────────────────────

  fastify.get('/api/v1/portal/notifications', async (request, reply) => {
    const tenantId = request.portalUser!.tenant_id;
    const q = request.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(q.limit ?? '20', 10), 100);
    const offset = parseInt(q.offset ?? '0', 10);

    const params: unknown[] = [tenantId];
    let readFilter = '';
    if (q.read !== undefined) {
      params.push(q.read === 'true');
      readFilter = ` AND read = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT *, COUNT(*) OVER() AS total_count
       FROM in_app_notifications
       WHERE tenant_id = $1${readFilter}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    const total = rows.length > 0 ? parseInt((rows[0] as { total_count: string }).total_count, 10) : 0;
    const notifications = rows.map(({ total_count: _tc, ...rest }) => rest);
    return reply.send({ notifications, total, limit, offset });
  });

  fastify.put('/api/v1/portal/notifications/:notificationId/read', async (request, reply) => {
    const { notificationId } = request.params as { notificationId: string };
    assertUUID(notificationId, 'notificationId');

    const tenantId = request.portalUser!.tenant_id;

    const { rows } = await pool.query<{ id: string; read: boolean }>(
      `SELECT id, read FROM in_app_notifications WHERE id = $1 AND tenant_id = $2`,
      [notificationId, tenantId],
    );
    if (rows.length === 0) throw new AppError(404, 'Notification not found');

    if (rows[0]!.read) {
      return reply.send({ id: notificationId, read: true });
    }

    await pool.query(
      `UPDATE in_app_notifications SET read = true WHERE id = $1`,
      [notificationId],
    );
    return reply.send({ id: notificationId, read: true });
  });

  // ── Profile ────────────────────────────────────────────────────────────────

  fastify.get('/api/v1/portal/profile', async (request, reply) => {
    const tenantId = request.portalUser!.tenant_id;

    const [{ rows: tenantRows }, { rows: productRows }] = await Promise.all([
      pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM tenants WHERE id = $1`,
        [tenantId],
      ),
      pool.query<{ id: string; name: string; slug: string }>(
        `SELECT id, name, slug FROM products WHERE tenant_id = $1 AND active = true ORDER BY name ASC`,
        [tenantId],
      ),
    ]);

    if (tenantRows.length === 0) throw new AppError(404, 'Tenant not found');
    return reply.send({ tenant: tenantRows[0], products: productRows });
  });
};

export default portalDataRoutes;
