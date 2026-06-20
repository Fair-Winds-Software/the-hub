// Authorized by HUB-1494 — GET + PUT /api/v1/admin/tenants/:tenantId/products/:productId/pricing
// Authorized by HUB-1495 — GET /api/v1/admin/tenants/:tenantId/invoices (D-005 per-product scope) + /:invoiceId detail
// Authorized by HUB-1496 — POST + DELETE /api/v1/admin/tenants/:tenantId/products/:productId/freeze (D-006)
// Authorized by HUB-1497 — GET /api/v1/admin/tenants/:tenantId/stripe-customer (super_admin only)
import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { getActivePricingModel, activatePricingModel } from '../../services/pricingModelService.js';
import type { TierInput } from '../../lib/pricingModelValidation.js';
import { getInvoices } from '../../services/invoiceService.js';
import { freezeLicense, unfreezeProduct } from '../../services/license.js';
import type { InvoiceRow } from '../../services/invoiceService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUUID(v: string, label: string): void {
  if (!UUID_RE.test(v)) throw new AppError(400, `${label} must be a valid UUID`);
}

function assertSuperAdmin(
  request: { operatorUser?: { role: string } },
): void {
  if (request.operatorUser?.role !== 'super_admin') throw new AppError(403, 'Forbidden');
}

function assertTenantAccess(
  request: { operatorUser?: { role: string; tenant_id: string | null } },
  tenantId: string,
): void {
  const op = request.operatorUser!;
  if (op.role === 'tenant_admin' && op.tenant_id !== tenantId) {
    throw new AppError(403, 'Forbidden');
  }
}

const adminBillingRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Pricing model routes ─────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/tenants/:tenantId/products/:productId/pricing', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertTenantAccess(request, tenantId);

    const model = await getActivePricingModel(productId);
    if (!model) throw new AppError(404, 'No active pricing model for this product');
    return reply.send(model);
  });

  fastify.put('/api/v1/admin/tenants/:tenantId/products/:productId/pricing', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertSuperAdmin(request);

    const body = request.body as Record<string, unknown> | null ?? {};
    const { modelType, currency, config, tiers } = body as {
      modelType?: unknown;
      currency?: unknown;
      config?: unknown;
      tiers?: unknown;
    };

    if (typeof modelType !== 'string' || !modelType) throw new AppError(400, 'modelType is required');
    if (typeof currency !== 'string' || !currency) throw new AppError(400, 'currency is required');
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new AppError(400, 'config must be an object');
    }

    const operatorId = request.operatorUser!.operator_id;
    const model = await activatePricingModel(
      productId,
      modelType,
      currency,
      config as Record<string, unknown>,
      Array.isArray(tiers) ? (tiers as TierInput[]) : undefined,
      operatorId,
    );
    return reply.status(201).send(model);
  });

  // ── Invoice routes ───────────────────────────────────────────────────────────

  fastify.get('/api/v1/admin/tenants/:tenantId/invoices', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    assertTenantAccess(request, tenantId);

    const q = request.query as Record<string, string>;
    // D-005: productId is required — cross-product invoice listing not supported
    if (!q.productId) throw new AppError(400, 'productId query param is required (D-005)');
    assertUUID(q.productId, 'productId');

    const limit = q.limit ? parseInt(q.limit, 10) : undefined;
    const invoices = await getInvoices(tenantId, q.productId, limit);
    return reply.send(invoices);
  });

  fastify.get('/api/v1/admin/tenants/:tenantId/invoices/:invoiceId', async (request, reply) => {
    const { tenantId, invoiceId } = request.params as { tenantId: string; invoiceId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(invoiceId, 'invoiceId');
    assertTenantAccess(request, tenantId);

    const { rows } = await getPool().query<InvoiceRow>(
      `SELECT id, tenant_id, product_id, stripe_invoice_id, stripe_subscription_id, status,
              amount_due, amount_paid, currency, period_start, period_end, invoice_pdf_url,
              payment_failed_at, created_at, updated_at
       FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId],
    );
    if (!rows[0]) throw new AppError(404, 'Invoice not found');
    return reply.send(rows[0]);
  });

  // ── Freeze / unfreeze routes (super_admin only; D-006 per-product scope) ────

  fastify.post('/api/v1/admin/tenants/:tenantId/products/:productId/freeze', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertSuperAdmin(request);

    await freezeLicense(tenantId, productId);
    return reply.send({ frozen: true });
  });

  fastify.delete('/api/v1/admin/tenants/:tenantId/products/:productId/freeze', async (request, reply) => {
    const { tenantId, productId } = request.params as { tenantId: string; productId: string };
    assertUUID(tenantId, 'tenantId');
    assertUUID(productId, 'productId');
    assertSuperAdmin(request);

    await unfreezeProduct(tenantId, productId);
    return reply.send({ frozen: false });
  });

  // ── Stripe customer link (super_admin only) ──────────────────────────────────

  fastify.get('/api/v1/admin/tenants/:tenantId/stripe-customer', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    assertUUID(tenantId, 'tenantId');
    assertSuperAdmin(request);

    const { rows } = await getPool().query<{ stripe_customer_id: string }>(
      'SELECT stripe_customer_id FROM stripe_customers WHERE tenant_id = $1',
      [tenantId],
    );
    if (!rows[0]) throw new AppError(404, 'No Stripe customer found for this tenant');
    return reply.send({ stripe_customer_id: rows[0].stripe_customer_id });
  });
};

export default adminBillingRoutes;
